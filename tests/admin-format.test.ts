import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, formatMoneyList } from '../apps/admin/src/lib/format.js';

test('非零极小费用不会显示为 0', () => {
  assert.notEqual(formatAmount(0.00000001, 'USD'), '$0.000000');
  assert.match(formatAmount(0.00000001, 'USD'), /0\.00000001/);
  assert.match(formatAmount(0.0004, 'USD'), /0\.000400/);
  assert.match(formatAmount(0.25, 'USD'), /0\.2500/);
  assert.equal(formatAmount(0, 'USD'), '$0.00');
  assert.equal(formatAmount(12.3, 'CNY', false), '¥12.30');
});

test('null 表示未知，空数组才表示无费用记录', () => {
  assert.equal(formatMoneyList(null), '未知');
  assert.equal(formatMoneyList(undefined), '未知');
  assert.equal(formatMoneyList([]), '无费用记录');
  assert.match(formatMoneyList([{ amount: 0.000001, currency: 'USD' }]), /0\.000001/);
});
