const test = require('node:test');
const assert = require('node:assert');
const { calculatePickup, chargeDistribution, PU_RATE } = require('./pickup-calc.js');
const { renderPickup } = require('./pickup.js');

test('チャージ分布は全質量が1で、期待値は既知の90.07連に一致する', () => {
  const dist = chargeDistribution();
  const mass = dist.reduce((sum, p) => sum + p, 0);
  assert.ok(Math.abs(mass - 1) < 1e-12);
  const expected = dist.reduce((sum, p, pull) => sum + p * pull, 0);
  assert.ok(Math.abs(expected - 90.07) < 0.01, `期待値 ${expected}`);
});

test('200連時点の3分岐は質量が保存され、畳み込み検算と一致する', () => {
  const result = calculatePickup();
  assert.ok(result.audit.branchMassError < 1e-12);
  assert.ok(result.audit.convolutionGap < 1e-12);
});

test('呼び出しポイントは全経路で200文字を下回らず、両者自引きだけが重複分を上積みする', () => {
  const result = calculatePickup();
  assert.ok(result.point.lettersAt200.both > 300);
  assert.strictEqual(result.point.lettersAt200.aOnly, 200);
  assert.ok(result.point.letters > result.charge.letters);
});

test('残業の期待連数は打ち切り付き幾何分布の期待値に一致する', () => {
  const result = calculatePickup();
  const q = 1 - PU_RATE;
  const closedForm = (1 - q ** 200) / PU_RATE;
  assert.ok(Math.abs(result.point.overtimePulls - closedForm) < 1e-9);
});

test('生成ページの数値が計算結果と一致する', () => {
  const result = calculatePickup();
  for (const locale of ['ja', 'en']) {
    const html = renderPickup(result, locale);
    assert.ok(html.includes(result.charge.expectedPulls.toFixed(1)), `${locale}: チャージ期待連数`);
    assert.ok(html.includes(result.point.expectedPulls.toFixed(1)), `${locale}: ポイント期待連数`);
    assert.ok(html.includes(`${(result.point.branches.both * 100).toFixed(1)}%`), `${locale}: 両者自引き率`);
    assert.ok(html.includes(result.verdict.chargeWins ? 'gain">呼び出しチャージ優位' : 'loss">呼び出しポイント優位')
      || locale === 'en', `${locale}: 優位判定`);
  }
});
