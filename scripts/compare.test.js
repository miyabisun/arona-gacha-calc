const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateComparison,
  rateForCharge,
  singleCycleDistribution,
  binomialTail,
} = require('./compare.js');

test('5.5周年のチャージ境界', () => {
  assert.equal(rateForCharge(0), 0.007);
  assert.equal(rateForCharge(99), 0.5);
  assert.equal(rateForCharge(100), 0.007);
  assert.equal(rateForCharge(199), 1);
});

test('単一PU所要回数分布の総和は1', () => {
  const cycle = singleCycleDistribution();
  const sum = cycle.reduce((total, probability) => total + probability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-14);
  assert.ok(Math.abs(cycle[100] - (0.993 ** 99) * 0.5) < 1e-15);
});

test('1.0周年の200連・2人は1人以上の自引き確率', () => {
  assert.ok(Math.abs(binomialTail(200, 1) - (1 - 0.993 ** 200)) < 1e-14);
});

test('二つの厳密計算法と全曲線の不変条件が一致する', () => {
  const result = calculateComparison();
  assert.ok(result.audit.anniversary5_5MaxCrossCheckDifference < 1e-12);
  assert.ok(result.audit.anniversary1_0MaxCrossCheckDifference < 1e-12);
  assert.ok(result.audit.maxMassError < 1e-12);
  assert.ok(result.audit.maxInvariantError < 1e-12);
  for (const target of [1, 2, 3, 4]) {
    assert.ok(Math.abs(result.curves.anniversary5_5[target][target * 200] - 1) < 1e-12);
    assert.ok(Math.abs(result.curves.anniversary1_0[target][target * 200] - 1) < 1e-12);
  }
});
