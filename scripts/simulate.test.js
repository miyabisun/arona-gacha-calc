const test = require('node:test');
const assert = require('node:assert/strict');
const { runSimulation, dkwErrorBound, exactNewCurves, exactOldCurves, oldCompletionPull } = require('./simulate.js');

test('DKW誤差上限は試行回数の平方根に反比例する', () => {
  assert.ok(Math.abs(dkwErrorBound(10_000) / dkwErrorBound(250_000) - 5) < 1e-12);
});

test('旧仕様の交換可能時点を正しく扱う', () => {
  assert.equal(oldCompletionPull([50], 2), 200);
  assert.equal(oldCompletionPull([50, 250], 3), 250);
  assert.equal(oldCompletionPull([], 2), 400);
  assert.equal(oldCompletionPull([], 3), Infinity);
});

test('既存の2人・200/300連の厳密値と一致する', () => {
  const fresh = exactNewCurves();
  const old = exactOldCurves();
  assert.ok(Math.abs(fresh[2][200] - 0.6408982403974756) < 1e-14);
  assert.ok(Math.abs(fresh[2][300] - 0.9474559227127183) < 1e-14);
  assert.ok(Math.abs(old[2][200] - (1 - 0.993 ** 200)) < 1e-14);
  assert.ok(Math.abs(old[3][400] - (1 - 0.993 ** 400)) < 1e-14);
  assert.ok(Math.abs(old[4][400] - (1 - 0.993 ** 400 - 400 * 0.007 * 0.993 ** 399)) < 1e-14);
  assert.ok(Math.abs(fresh[3][400] - 0.902456439466442) < 1e-14);
  assert.ok(Math.abs(fresh[4][400] - 0.6432222639296725) < 1e-14);
});

test('厳密曲線は0〜1の範囲で単調非減少', () => {
  for (const curves of [exactNewCurves(), exactOldCurves()]) {
    for (const target of [2, 3, 4]) {
      for (let pull = 1; pull <= 400; pull += 1) {
        assert.ok(curves[target][pull] >= curves[target][pull - 1] - 1e-15);
        assert.ok(curves[target][pull] >= 0 && curves[target][pull] <= 1 + 1e-14);
      }
    }
  }
});

test('固定シードで再現できる', () => {
  assert.deepEqual(runSimulation(100), runSimulation(100));
});
