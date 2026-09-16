import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Bytes, sha256Hex, toHex } from '../src/sha256.js';

/**
 * 自研 SHA-256 的正确性验证。
 *
 * 两条独立证据：
 * 1. FIPS 180-4 官方标准向量（"abc"、空串、448bit 长消息、一百万个 'a'）。
 * 2. 与 Node 内置 `node:crypto` 在大量随机输入上交叉比对，覆盖补位边界
 *    （55/56/63/64/65 字节）—— 这里是 SHA-256 实现最容易写错的长度分界。
 *
 * 为什么坚持自研而不是直接用 node:crypto：core 需要被浏览器端复用，
 * 静态引入 node 内置模块会让 Vite 的浏览器构建失败（见 src/sha256.ts 注释）。
 */

const NIST_VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

test('sha256 命中 FIPS 180-4 标准向量', () => {
  for (const [input, expected] of NIST_VECTORS) {
    assert.equal(sha256Hex(input), expected, `输入长度 ${input.length} 的摘要不匹配`);
  }
});

test('sha256 命中补位边界（55/56/63/64/65 字节）', () => {
  for (const n of [54, 55, 56, 57, 62, 63, 64, 65, 66, 119, 120, 128, 200]) {
    const input = 'a'.repeat(n);
    const viaNode = createHash('sha256').update(input, 'utf8').digest('hex');
    assert.equal(sha256Hex(input), viaNode, `${n} 字节输入与 node:crypto 不一致`);
  }
});

test('sha256 在多字节 UTF-8 上与 node:crypto 一致', () => {
  const samples = [
    '中文测试：AI Control Center',
    'emoji 🎯🧮 与混合 ASCII abc',
    '换行\n与\t制表符',
    'Ａ全角Ｂ',
    '한국어 테스트',
  ];
  for (const s of samples) {
    const viaNode = createHash('sha256').update(s, 'utf8').digest('hex');
    assert.equal(sha256Hex(s), viaNode, `样本 ${JSON.stringify(s)} 不一致`);
  }
});

test('sha256 在多块随机输入上与 node:crypto 一致', () => {
  // 覆盖 1 块以上（>64 字节）的情况，确保 64 字节分块逻辑正确
  for (let i = 0; i < 64; i += 1) {
    const len = 1 + ((i * 37) % 500);
    let s = '';
    for (let k = 0; k < len; k += 1) s += String.fromCharCode(32 + ((k * 7 + i) % 90));
    const viaNode = createHash('sha256').update(s, 'utf8').digest('hex');
    assert.equal(sha256Hex(s), viaNode, `随机样本 #${i}（${len} 字符）不一致`);
  }
});

test('sha256Bytes 接受原始字节，也接受非零 offset 的切片', () => {
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const slice = buf.subarray(2, 6); // 内部 byteOffset !== 0
  const expected = createHash('sha256').update(Buffer.from([3, 4, 5, 6])).digest('hex');
  assert.equal(toHex(sha256Bytes(slice)), expected);
});
