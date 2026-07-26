const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateComparison,
  rateForCharge,
  singleCycleDistribution,
  binomialTail,
  renderHtml,
  standaloneSvg,
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
  for (const target of Array.from({ length: 10 }, (_, index) => index + 1)) {
    assert.ok(Math.abs(result.curves.anniversary5_5[target][target * 200] - 1) < 1e-12);
    assert.ok(Math.abs(result.curves.anniversary1_0[target][target * 200] - 1) < 1e-12);
  }
});

test('1〜10PUタブと2PU初期表示を生成する', () => {
  const result = calculateComparison();
  const html = renderHtml(result);
  assert.equal((html.match(/<button type="button" role="tab"/g) ?? []).length, 10);
  assert.match(html, /data-target="2">2pu<\/button>/);
  assert.match(html, /let selected=2/);
  assert.match(html, /toFixed\(2\)/);
  assert.doesNotMatch(html, /75% SAFE|安全圏|1\.0周年|5\.5周年/);
});

test('1〜4PU向けの独立SVGを生成できる', () => {
  const result = calculateComparison();
  for (let target = 1; target <= 4; target += 1) {
    const svg = standaloneSvg(result, target);
    assert.match(svg, /^<svg /);
    assert.match(svg, new RegExp(`${target}PUのガチャ確率`));
    assert.equal((svg.match(/class="curve /g) ?? []).length, 2);
  }
});
