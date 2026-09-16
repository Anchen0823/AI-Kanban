import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMoney,
  convertMoney,
  formatMoney,
  isZeroMoney,
  minorUnits,
  moneyFromDecimal,
  negateMoney,
  parseAmountMinor,
  subMoney,
  sumByCurrency,
  toDecimalString,
} from '../src/money.js';

/** 金额：定点整数、币种隔离、精度不丢。设计稿 §5.4 / INV-08。 */

test('定点金额：小数与最小单位互转', () => {
  assert.deepEqual(moneyFromDecimal('19.99', 'cny'), { amountMinor: '1999', currency: 'CNY' });
  assert.equal(toDecimalString({ amountMinor: '1999', currency: 'CNY' }), '19.99');
  assert.equal(toDecimalString({ amountMinor: '-1999', currency: 'CNY' }), '-19.99');
  assert.equal(toDecimalString({ amountMinor: '5', currency: 'CNY' }), '0.05');
  assert.equal(toDecimalString({ amountMinor: '0', currency: 'CNY' }), '0.00');
});

test('定点金额：JPY 无小数位', () => {
  assert.equal(minorUnits('JPY'), 0);
  assert.equal(toDecimalString({ amountMinor: '1200', currency: 'JPY' }), '1200');
  assert.deepEqual(moneyFromDecimal('1200', 'JPY'), { amountMinor: '1200', currency: 'JPY' });
  assert.throws(() => moneyFromDecimal('12.5', 'JPY'), /最多 0 位小数/);
});

test('定点金额：超出币种精度时报错，不做静默四舍五入', () => {
  assert.throws(() => moneyFromDecimal('1.005', 'CNY'), /最多 2 位小数/);
});

test('定点金额：大整数不丢精度（超过 2^53）', () => {
  const big = '9007199254740993';
  assert.equal(parseAmountMinor(big), 9007199254740993n);
  const a: { amountMinor: string; currency: string } = { amountMinor: big, currency: 'CNY' };
  const b: { amountMinor: string; currency: string } = { amountMinor: '1', currency: 'CNY' };
  assert.equal(addMoney(a, b).amountMinor, '9007199254740994');

  // 同样的运算用 Number 做会直接吞掉 +1，这就是为什么金额必须走 BigInt
  const viaNumber = String(Number(big) + 1);
  assert.notEqual(viaNumber, '9007199254740994');
});

test('INV-08：不同币种不能相加，必须先换汇', () => {
  const cny = { amountMinor: '1000', currency: 'CNY' };
  const usd = { amountMinor: '1000', currency: 'USD' };
  assert.throws(() => addMoney(cny, usd), /不同币种不能相加/);
  assert.throws(() => subMoney(cny, usd), /不同币种不能相减/);
});

test('sumByCurrency 按币种分行汇总，绝不返回跨币种总数', () => {
  const result = sumByCurrency([
    { amountMinor: '1000', currency: 'CNY' },
    { amountMinor: '2500', currency: 'CNY' },
    { amountMinor: '999', currency: 'USD' },
    { amountMinor: '1', currency: 'JPY' },
  ]);
  assert.deepEqual(result, [
    { currency: 'CNY', amountMinor: '3500', count: 2 },
    { currency: 'JPY', amountMinor: '1', count: 1 },
    { currency: 'USD', amountMinor: '999', count: 1 },
  ]);
});

test('退款用负金额表达，求和时自然抵消', () => {
  const paid = { amountMinor: '2000', currency: 'CNY' };
  const refund = negateMoney({ amountMinor: '2000', currency: 'CNY' });
  assert.equal(addMoney(paid, refund).amountMinor, '0');
  assert.ok(isZeroMoney(addMoney(paid, refund)));
});

test('换汇必须带汇率来源，且币种要匹配', () => {
  const usd = { amountMinor: '10000', currency: 'USD' };
  const converted = convertMoney(usd, {
    from: 'USD',
    to: 'CNY',
    rate: '7.1234',
    rateDate: '2026-09-16',
    rateSource: '用户手填',
  });
  // 100.00 USD × 7.1234 = 712.34 CNY
  assert.equal(converted.currency, 'CNY');
  assert.equal(toDecimalString(converted), '712.34');

  assert.throws(
    () => convertMoney(usd, { from: 'EUR', to: 'CNY', rate: '7.8', rateDate: '2026-09-16', rateSource: 'x' }),
    /汇率与金额币种不匹配/,
  );
});

test('金额字面量校验：拒绝浮点与千分位', () => {
  assert.doesNotThrow(() => parseAmountMinor('1999'));
  assert.doesNotThrow(() => parseAmountMinor('0'));
  assert.doesNotThrow(() => parseAmountMinor('-5'));
  assert.throws(() => parseAmountMinor('19.99'), /非法金额/);
  assert.throws(() => parseAmountMinor('1,999'), /非法金额/);
  assert.throws(() => parseAmountMinor('01'), /非法金额/);
  assert.throws(() => parseAmountMinor('abc'), /非法金额/);
});

test('币种代码规范化与校验：RMB 归一到 CNY，非法代码拒绝', () => {
  assert.equal(moneyFromDecimal('1.00', 'cny').currency, 'CNY');
  assert.equal(moneyFromDecimal('1.00', 'RMB').currency, 'CNY', 'RMB 与 CNY 必须落进同一个汇总桶');
  assert.equal(moneyFromDecimal('1.00', 'rmb').currency, 'CNY');
  assert.throws(() => moneyFromDecimal('1.00', 'C'), /非法币种/);
  assert.throws(() => moneyFromDecimal('1.00', '12A'), /非法币种/);
  assert.throws(() => moneyFromDecimal('1.00', '元'), /非法币种/);
});

test('展示格式：中文环境输出 ¥（仅界面用，不参与计算）', () => {
  const formatted = formatMoney({ amountMinor: '1999', currency: 'CNY' });
  assert.ok(formatted.includes('19.99'), `期望包含 19.99，实际 ${formatted}`);
});
