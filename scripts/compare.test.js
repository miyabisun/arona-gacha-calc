const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateComparison,
  rateForCharge,
  singleCycleDistribution,
  binomialTail,
  totalWithTickets,
  practicalChargeCurves,
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
  assert.match(html, /\.chart-tip\{position:absolute;display:none/);
  assert.match(html, /連\\n呼出チャージ/);
  assert.match(html, /github\.com\/miyabisun\/arona-gacha-calc/);
  assert.match(html, /pointTop=pointY\/H\*rect\.height/);
  assert.match(html, /tip\.style\.left=/);
  assert.match(html, /tip\.style\.top=\(pointTop\+8\)/);
  assert.doesNotMatch(html, /\.chart-tip\{position:absolute;right:8px;bottom:8px/);
  assert.doesNotMatch(html, /75% SAFE|安全圏|1\.0周年|5\.5周年/);
});

test('英語版の理論値比較と日英切替を生成する', () => {
  const result = calculateComparison();
  const japanese = renderHtml(result, 'ja', 'theory');
  const english = renderHtml(result, 'en', 'theory');
  assert.match(japanese, /href="en\/theory.html" lang="en" hreflang="en">EN/);
  assert.match(japanese, /2PUが揃う確率（1〜400連）/);
  assert.match(japanese, /1PUを獲得できる確率（1〜200連）/);
  assert.match(english, /<html lang="en">/);
  assert.match(english, /href="\.\.\/theory.html" lang="ja" hreflang="ja">JP/);
  assert.match(english, /rel="alternate" hreflang="x-default"/);
  assert.match(english, /languageLink\.hash=location\.hash/);
  assert.match(english, /Blue Archive Recruitment Probability Chart/);
  assert.match(english, /Recruitment Charge \(solid\)/);
  assert.match(english, /Recruitment Points \(dashed\)/);
  assert.match(english, /Probability of obtaining 2 PUs \(1–400 pulls\)/);
  assert.match(english, /function chartTitle\(target\)/);
  assert.match(english, /target===1\?' PU':' PUs'/);
  assert.match(english, /current\+' pulls\\nRecruitment Charge/);
  assert.doesNotMatch(english, /[ぁ-んァ-ヶ一-龠]/);
});

test('1〜4PU向けの独立SVGを生成できる', () => {
  const result = calculateComparison();
  for (let target = 1; target <= 4; target += 1) {
    const svg = standaloneSvg(result, target);
    assert.match(svg, /^<svg /);
    assert.match(svg, new RegExp(`${target}PUのガチャ確率`));
    assert.match(svg, /class="y-label"/);
    assert.match(svg, /\.grid \.y-label\{text-anchor:end\}/);
    assert.equal((svg.match(/class="curve /g) ?? []).length, 2);
  }
});

test('実践値: チケットの崖と累計換算', () => {
  assert.equal(totalWithTickets(69), 69);
  assert.equal(totalWithTickets(70), 80);
  assert.equal(totalWithTickets(120), 140);
  assert.equal(totalWithTickets(140), 180);
  assert.equal(totalWithTickets(160), 200);
  assert.equal(totalWithTickets(300), 380);
  const result = calculateComparison();
  const practical = practicalChargeCurves(result);
  assert.equal(practical[1][69], result.curves.anniversary5_5[1][69]);
  assert.equal(practical[1][70], result.curves.anniversary5_5[1][80]);
  assert.ok(Math.abs(practical[1][160] - 1) < 1e-12);
  for (let paid = 1; paid <= 400; paid += 1) {
    assert.ok(practical[2][paid] >= practical[2][paid - 1] - 1e-15);
  }
});

test('実践値ページ(index)は持出連軸で生成される', () => {
  const result = calculateComparison();
  const japanese = renderHtml(result);
  assert.match(japanese, /BlueArchive ガチャ実践値比較/);
  assert.match(japanese, /持出1〜400連/);
  assert.match(japanese, /'持出'\+current/);
  assert.match(japanese, /実践値の前提/);
  const english = renderHtml(result, 'en');
  assert.match(english, /paid pulls/);
  assert.match(english, /Practical Recruitment Chart/);
  assert.doesNotMatch(english, /[ぁ-んァ-ヶ一-龠]/);
});
