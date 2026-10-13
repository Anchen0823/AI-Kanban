import { createHash, randomUUID } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { BACKUP_MAX_BYTES, type RemoteBackup } from '@aicc/core';

export class DavError extends Error {
  constructor(public code: 'auth' | 'network' | 'protocol' | 'integrity', message: string) { super(message); }
}
export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new DavError('protocol', '请输入不含凭据和查询参数的 HTTPS WebDAV 地址。');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class WebDav {
  private base: URL;
  constructor(endpoint: string, private username: string, private password: string, private signal?: AbortSignal,
    private transport: typeof fetch = fetch) { this.base = new URL(normalizeEndpoint(endpoint)); }
  private url(path: string): URL {
    if (path.split('/').some(p => p === '..' || p === '.' || /[%\\?#]/.test(p))) throw new DavError('protocol', '远端路径无效。');
    return new URL(path.split('/').map(encodeURIComponent).join('/'), this.base);
  }
  private async request(method: string, path: string, body?: Buffer | string, extra: Record<string, string> = {}, maxBytes = BACKUP_MAX_BYTES): Promise<{ status: number; bytes: Buffer }> {
    try {
      const response = await this.transport(this.url(path), {
        method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), ...(this.signal ? [this.signal] : [])]),
        headers: { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`, ...extra },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }),
      });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new DavError('auth', 'WebDAV 认证失败，请检查用户名、应用密码和目录权限。'); }
      if (response.status >= 500 || response.status === 429) { await response.body?.cancel(); throw new DavError('network', 'WebDAV 暂时不可用，请稍后重试。'); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new DavError('protocol', '远端文件超过允许大小。'); }
      const chunks: Buffer[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length; if (size > maxBytes) throw new DavError('protocol', '远端响应超过允许大小。'); chunks.push(Buffer.from(chunk));
      }
      return { status: response.status, bytes: Buffer.concat(chunks) };
    } catch (error) { if (error instanceof DavError) throw error; throw new DavError('network', 'WebDAV 连接失败或超时，请检查网络与服务地址。'); }
  }
  private ok(status: number, allowed = [200, 201, 204]): void { if (!allowed.includes(status)) throw new DavError('protocol', `WebDAV 不支持此操作或路径不可用（HTTP ${status}）。`); }
  async mkdir(path: string): Promise<void> { this.ok((await this.request('MKCOL', `${path}/`)).status, [201, 405]); }
  async put(path: string, bytes: Buffer): Promise<void> { this.ok((await this.request('PUT', path, bytes, { 'content-type': 'application/octet-stream' })).status); }
  async get(path: string): Promise<Buffer> { const r = await this.request('GET', path); this.ok(r.status, [200]); return r.bytes; }
  async move(from: string, to: string): Promise<void> { this.ok((await this.request('MOVE', from, undefined, { Destination: this.url(to).href, Overwrite: 'F' })).status); }
  async remove(path: string): Promise<void> { this.ok((await this.request('DELETE', path)).status, [200, 204, 404]); }
  async list(path: string): Promise<Array<{ path: string; bytes: number; modified: string; directory: boolean }>> {
    const r = await this.request('PROPFIND', `${path}/`, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>', { Depth: '1', 'content-type': 'application/xml' }, 4 * 1024 * 1024);
    this.ok(r.status, [207]);
    const xml = r.bytes.toString();
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DavError('protocol', 'WebDAV 返回了不支持的 XML。');
    let malformed = false;
    const document = new DOMParser({ errorHandler: { warning: () => { malformed = true; }, error: () => { malformed = true; }, fatalError: () => { malformed = true; } } }).parseFromString(xml, 'application/xml');
    if (malformed || document.documentElement.namespaceURI !== 'DAV:' || document.documentElement.localName !== 'multistatus') throw new DavError('protocol', 'WebDAV 返回无效目录列表。');
    const rows = document.getElementsByTagNameNS('DAV:', 'response'), result = [];
    const parent = this.url(`${path}/`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows.item(i)!;
      const href = row.getElementsByTagNameNS('DAV:', 'href').item(0)?.textContent;
      if (!href) continue;
      const url = new URL(href, parent);
      if (url.origin !== parent.origin || !url.pathname.startsWith(parent.pathname)) continue;
      const tail = url.pathname.slice(parent.pathname.length).replace(/\/$/, '');
      if (!tail || tail.includes('/')) continue;
      const child = decodeURIComponent(tail); if (!/^[a-zA-Z0-9._-]+$/.test(child)) continue;
      const size = Number(row.getElementsByTagNameNS('DAV:', 'getcontentlength').item(0)?.textContent ?? 0);
      result.push({ path: `${path}/${child}`, bytes: Number.isFinite(size) && size >= 0 ? size : 0,
        modified: row.getElementsByTagNameNS('DAV:', 'getlastmodified').item(0)?.textContent ?? '', directory: row.getElementsByTagNameNS('DAV:', 'collection').length > 0 });
    }
    return result;
  }
  async prepare(device: string): Promise<string> { await this.mkdir('AI-Control-Center'); const path = `AI-Control-Center/${device}`; await this.mkdir(path); return path; }
  async test(device: string): Promise<void> {
    const root = await this.prepare(device), path = `${root}/.probe-${randomUUID()}`, moved = `${path}-moved`, bytes = Buffer.from(randomUUID());
    try { await this.list(root); await this.put(path, bytes); if (!(await this.get(path)).equals(bytes)) throw new DavError('integrity', 'WebDAV 回读校验失败。'); await this.move(path, moved); if (!(await this.get(moved)).equals(bytes)) throw new DavError('integrity', 'WebDAV 重命名校验失败。'); }
    finally { await this.remove(path); await this.remove(moved); }
  }
  async upload(device: string, id: string, bytes: Buffer, verifying: () => void): Promise<string> {
    const root = await this.prepare(device), target = `${root}/${id}.aiccbackup`, temporary = `${root}/.${id}.partial`;
    // A retry after a lost MOVE response is idempotent.
    if ((await this.list(root)).some(row => row.path === target)) {
      if (hash(await this.get(target)) !== hash(bytes)) throw new DavError('integrity', '远端存在不同内容的同名备份。'); return target;
    }
    await this.put(temporary, bytes); verifying();
    if (hash(await this.get(temporary)) !== hash(bytes)) throw new DavError('integrity', '上传回读校验失败，未发布此备份。');
    await this.move(temporary, target); return target;
  }
  async backups(): Promise<RemoteBackup[]> {
    const result: RemoteBackup[] = [];
    for (const device of await this.list('AI-Control-Center')) {
      if (!device.directory || !/^AI-Control-Center\/[a-f0-9-]{36}$/.test(device.path)) continue;
      for (const row of await this.list(device.path)) if (!row.directory && /^[a-f0-9-]{36}\.aiccbackup$/.test(row.path.split('/').at(-1)!)) {
        result.push({ id: row.path, name: row.path.split('/').at(-1)!, bytes: row.bytes, modified: row.modified });
      }
    }
    return result.sort((a, b) => b.modified.localeCompare(a.modified));
  }
}
