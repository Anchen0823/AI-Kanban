/**
 * 纯 TypeScript 的 SHA-256。
 *
 * 为什么不用 `node:crypto`：core 包同时被 Node 服务端和浏览器端前端引用，一旦在模块顶层
 * 静态引入 node 内置模块，Vite 的浏览器构建就会失败。自己实现一份同步、无依赖、可同构的
 * 哈希，换来 core 的「无 I/O、可双端复用」。
 *
 * 正确性由 test/sha256.test.ts 用 NIST/FIPS 标准向量与 Node 内置实现交叉验证。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = bytes.length;
  const paddedLen = (((len + 9 + 63) >> 6) << 6) >>> 0;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 4294967296), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15] as number;
      const y = w[t - 2] as number;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }

    let a = H[0] as number;
    let b = H[1] as number;
    let c = H[2] as number;
    let d = H[3] as number;
    let e = H[4] as number;
    let f = H[5] as number;
    let g = H[6] as number;
    let h = H[7] as number;

    for (let t = 0; t < 64; t += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = ((H[0] as number) + a) >>> 0;
    H[1] = ((H[1] as number) + b) >>> 0;
    H[2] = ((H[2] as number) + c) >>> 0;
    H[3] = ((H[3] as number) + d) >>> 0;
    H[4] = ((H[4] as number) + e) >>> 0;
    H[5] = ((H[5] as number) + f) >>> 0;
    H[6] = ((H[6] as number) + g) >>> 0;
    H[7] = ((H[7] as number) + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, H[i] as number, false);
  }
  return out;
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += HEX[(b >> 4) & 0x0f];
    s += HEX[b & 0x0f];
  }
  return s;
}

const encoder = new TextEncoder();

export function sha256Hex(input: string): string {
  return toHex(sha256Bytes(encoder.encode(input)));
}

/**
 * 短指纹：40 位十六进制。仅用于「同一条记录是否见过」这类非安全用途，
 * 碰撞概率对本地单用户数据集可忽略。
 */
export function shortFingerprint(input: string): string {
  return sha256Hex(input).slice(0, 40);
}
