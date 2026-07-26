const test = require('node:test');
const assert = require('node:assert/strict');

const { calculate, puRate, singleCycleDistribution, expectedPulls } = require('./calculate.js');

test('チャージ境界ごとのPU率', () => {
  assert.equal(puRate(0), 0.007);
  assert.equal(puRate(98), 0.007);
  assert.equal(puRate(99), 0.5);
  assert.equal(puRate(100), 0.007);
  assert.equal(puRate(199), 1);
});

test('1人目の100連以内確率は解析式と一致する', () => {
  const single = singleCycleDistribution(200);
  const expected = 1 - (0.993 ** 99) * 0.5;
  assert.ok(Math.abs(single.cumulative[100] - expected) < 1e-15);
  assert.ok(Math.abs(single.cumulative[200] - 1) < 1e-14);
});

test('全状態DPと独立した畳み込み検算が一致する', () => {
  const result = calculate();
  assert.ok(result.audit.maxMassError < 1e-12);
  assert.ok(result.audit.maxCrossCheckDifference < 1e-12);
  assert.ok(Math.abs(result.summary['200'].newTwoPUs - 0.6408982403974756) < 1e-15);
  assert.ok(Math.abs(result.summary['300'].newTwoPUs - 0.9474559227127183) < 1e-15);
});

test('累積確率から期待募集回数を求める', () => {
  assert.equal(expectedPulls([0, 0.5, 1], 2), 1.5);
});
