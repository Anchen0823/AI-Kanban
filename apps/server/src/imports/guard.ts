/**
 * 导入安全守卫（设计稿 §12 最后一段）。
 *
 * ZIP / JSON / CSV 导入必须：限制大小与解压比例、阻止路径穿越、拒绝可执行文件与嵌入脚本、
 * 只解析必要文本、渲染时转义 HTML、导出 CSV 时防止公式注入。
 *
 * 这里刻意「宁可拒绝，不去猜」。一个格式不对的文件被明确拒绝，比被半解析后写进主库要好得多。
 */

/** 常见可执行 / 二进制文件头。命中即拒绝，不做嗅探式容错。 */
const BINARY_MAGIC: Array<{ name: string; bytes: number[] }> = [
  { name: 'ZIP 压缩包', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'GZIP 压缩流', bytes: [0x1f, 0x8b] },
  { name: 'Windows 可执行文件', bytes: [0x4d, 0x5a] },
  { name: 'ELF 可执行文件', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O 可执行文件', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: 'SQLite 数据库', bytes: [0x53, 0x51, 0x4c, 0x69] },
];

/** 文本里出现这些片段说明带了脚本或可执行结构。 */
const SCRIPT_MARKERS = [
  '<script',
  '</script',
  'javascript:',
  'data:text/html',
  '<?php',
  '<%',
  '#!/',
  'powershell -',
  'cmd.exe /c',
  'base64 -d',
  'eval(',
];

export interface GuardFailure {
  ok: false;
  code:
    | 'too_large'
    | 'empty'
    | 'path_traversal'
    | 'binary_content'
    | 'nul_byte'
    | 'script_content'
    | 'extension_not_allowed';
  message: string;
}

export interface GuardSuccess {
  ok: true;
  bytes: number;
  /** 是否包含需要提醒用户的可疑片段（不阻断，只提示）。 */
  notices: string[];
}

export type GuardResult = GuardSuccess | GuardFailure;

export interface GuardOptions {
  maxBytes: number;
  /** 允许的扩展名（小写，含点）。 */
  allowedExtensions: string[];
}

export function guardImportPayload(fileName: string, content: string, options: GuardOptions): GuardResult {
  const notices: string[] = [];
  const bytes = byteLength(content);

  if (bytes === 0) {
    return { ok: false, code: 'empty', message: '文件内容为空' };
  }
  if (bytes > options.maxBytes) {
    return {
      ok: false,
      code: 'too_large',
      message: `文件 ${formatBytes(bytes)} 超过单次导入上限 ${formatBytes(options.maxBytes)}。请拆分后再导入。`,
    };
  }

  const traversal = checkFileName(fileName);
  if (traversal) return traversal;

  const lower = fileName.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (!options.allowedExtensions.includes(ext)) {
    return {
      ok: false,
      code: 'extension_not_allowed',
      message: `不支持的扩展名 ${ext || '（无）'}。本版本只接受：${options.allowedExtensions.join('、')}`,
    };
  }

  if (content.includes('\u0000')) {
    return { ok: false, code: 'nul_byte', message: '文件包含 NUL 字节，看起来不是纯文本，已拒绝解析' };
  }

  const head = new Uint8Array(Math.min(8, bytes));
  for (let i = 0; i < head.length; i += 1) head[i] = content.charCodeAt(i) & 0xff;
  for (const magic of BINARY_MAGIC) {
    if (magic.bytes.every((b, i) => head[i] === b)) {
      return {
        ok: false,
        code: 'binary_content',
        message: `文件头匹配「${magic.name}」，本版本只支持纯文本 CSV / JSON。原始文件未被修改，也未写入任何数据。`,
      };
    }
  }

  const lowerContent = content.slice(0, 4096).toLowerCase();
  for (const marker of SCRIPT_MARKERS) {
    if (lowerContent.includes(marker)) {
      return {
        ok: false,
        code: 'script_content',
        message: `内容中出现脚本特征片段 ${JSON.stringify(marker)}，已按不可信输入拒绝解析`,
      };
    }
  }

  // 这些不阻断导入，但界面要提示用户：数据里真的出现了这种字符串。
  if (content.includes('忽略规则') || content.toLowerCase().includes('ignore previous')) {
    notices.push('内容中包含类似指令注入的文本，会被当作普通数据处理，不会影响任何权限判断（M04）。');
  }

  return { ok: true, bytes, notices };
}

function checkFileName(fileName: string): GuardFailure | null {
  if (fileName.includes('..')) {
    return { ok: false, code: 'path_traversal', message: '文件名包含「..」，已拒绝以防路径穿越' };
  }
  if (fileName.includes('/') || fileName.includes('\\')) {
    return { ok: false, code: 'path_traversal', message: '文件名包含路径分隔符，只接受纯文件名' };
  }
  if (/^[a-zA-Z]:/.test(fileName)) {
    return { ok: false, code: 'path_traversal', message: '文件名包含盘符，只接受纯文件名' };
  }
  if (/[\u0000-\u001f]/.test(fileName)) {
    return { ok: false, code: 'path_traversal', message: '文件名包含控制字符' };
  }
  return null;
}

export function byteLength(text: string): number {
  // 不依赖 Buffer，让这段逻辑在浏览器端也能用于预检。
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x7f) n += 1;
    else if (cp <= 0x7ff) n += 2;
    else if (cp <= 0xffff) n += 3;
    else n += 4;
  }
  return n;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * CSV 公式注入防护。
 *
 * 以 `= + - @` 或制表符/回车开头的单元格，在 Excel / WPS 里会被当公式执行。
 * 导出时在最前面加一个单引号，让接收方看到的是文本。
 */
export function escapeCsvFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (v: string | number | null): string => {
    if (v === null) return '';
    const s = escapeCsvFormula(String(v));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * 渲染到前端前的 HTML 转义。
 * 导入的记忆正文可能包含 HTML，服务端与前端两边都做转义，不假设对方做了。
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
