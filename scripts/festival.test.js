const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateComparison } = require('./compare.js');
const {
  calculateFestival,
  renderFestival,
  runFestivalDp,
  chargeHitRate,
  chargeResidual,
  SPOOK_EACH_RATE,
  MAX_PULLS,
  TARGETS,
  TABLE_PULLS,
} = require('./festival.js');

test('確定枠と残り抽選枠の境界', () => {
  assert.equal(chargeHitRate(0), 0.007);
  assert.equal(chargeHitRate(98), 0.007);
  assert.equal(chargeHitRate(99), 0.5);
  assert.equal(chargeHitRate(100), 0.007);
  assert.equal(chargeHitRate(199), 1);
  assert.equal(chargeResidual(0), 1);
  assert.equal(chargeResidual(99), 0.5);
  assert.equal(chargeResidual(199), 0);
});

test('すり抜けは9名で0.9%を等分する', () => {
  assert.ok(Math.abs(SPOOK_EACH_RATE - 0.001) < 1e-18);
});

test('確率質量が保存され、曲線は0〜1で単調非減少', () => {
  const result = calculateFestival();
  assert.ok(result.audit.maxMassError < 1e-12);
  for (const scenario of Object.values(result.scenarios)) {
    for (const target of TARGETS) {
      for (const name of ['allBase', 'allBonus']) {
        const curve = scenario[target][name];
        for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
          assert.ok(curve[pull] >= curve[pull - 1] - 1e-15, `${name} が減少`);
          assert.ok(curve[pull] >= 0 && curve[pull] <= 1 + 1e-12);
        }
      }
      // 素体は必ずボーナス以上に集まる。
      for (let pull = 0; pull <= MAX_PULLS; pull += 1) {
        assert.ok(scenario[target].allBase[pull] >= scenario[target].allBonus[pull] - 1e-15);
        assert.ok(scenario[target].expectedBase[pull] >= scenario[target].expectedBonus[pull] - 1e-15);
      }
    }
  }
});

test('初回PUボーナスの曲線はすり抜けの影響を受けず既存の厳密計算と一致する', () => {
  // すり抜けは素体だけを増やしボーナスには寄与しないため、
  // ボーナス側の分布はフェス限でない通常の比較と完全に一致しなければならない。
  const festival = calculateFestival();
  const comparison = calculateComparison();
  for (const target of TARGETS) {
    for (let pull = 0; pull <= 600; pull += 1) {
      assert.ok(
        Math.abs(festival.scenarios.charge[target].allBonus[pull] - comparison.curves.anniversary5_5[target][pull]) < 1e-12,
        `呼出チャージ ${target}人 ${pull}連で不一致`,
      );
      assert.ok(
        Math.abs(festival.scenarios.point[target].allBonus[pull] - comparison.curves.anniversary1_0[target][pull]) < 1e-12,
        `呼出ポイント ${target}人 ${pull}連で不一致`,
      );
    }
  }
});

test('すり抜けを止めると素体とボーナスの曲線が一致する', () => {
  // 1人狙いでは他に狙う生徒がいないため、すり抜けの寄与が消える。
  const { curves } = runFestivalDp(1, { useCharge: true, useExchange: false });
  for (let pull = 0; pull <= MAX_PULLS; pull += 1) {
    assert.ok(Math.abs(curves.allBase[pull] - curves.allBonus[pull]) < 1e-15);
  }
  assert.ok(Math.abs(curves.allBonus[200] - 1) < 1e-12);
});

test('呼出チャージを99まで貯めた状態では最初の募集で50%を得る', () => {
  const { curves } = runFestivalDp(2, { useCharge: true, useExchange: false, initialCharge: 99 });
  assert.ok(Math.abs(curves.expectedBonus[1] - 0.5) < 1e-15);
});

test('日英のフェス限ページとページ対応の言語切替を生成する', () => {
  const result = calculateFestival();
  const japanese = renderFestival(result);
  const english = renderFestival(result, 'en');

  assert.match(japanese, /<html lang="ja">/);
  assert.match(japanese, /<a href="festival\.html" aria-current="page">5\.5th<\/a>/);
  assert.match(japanese, /href="en\/festival\.html" lang="en" hreflang="en">EN/);
  assert.match(japanese, /hreflang="ja" href="https:\/\/miyabisun\.github\.io\/arona-gacha-calc\/festival\.html"/);

  assert.match(english, /<html lang="en">/);
  assert.match(english, /<a href="festival\.html" aria-current="page">5\.5th<\/a>/);
  assert.match(english, /href="\.\.\/festival\.html" lang="ja" hreflang="ja">JP/);
  assert.match(english, /rel="alternate" hreflang="x-default"/);
  assert.doesNotMatch(english, /[ぁ-んァ-ヶ一-龠]/);

  // 到達率・期待回数・99連の3表と、狙う人数ごとに区切った本体。
  for (const html of [japanese, english]) {
    assert.equal((html.match(/<table>/g) ?? []).length, 3);
    assert.equal((html.match(/<colgroup>/g) ?? []).length, 3);
    assert.equal((html.match(/<tbody>/g) ?? []).length, TARGETS.length + 2);
    assert.doesNotMatch(html, /table-wrap|overflow-x/);
  }
});

test('生成ページの数値が計算結果と一致する', () => {
  const result = calculateFestival();
  const html = renderFestival(result);
  const shown = (value) => `${(value * 100).toFixed(2)}%`;
  for (const target of TARGETS) {
    for (const pull of TABLE_PULLS[target]) {
      assert.ok(html.includes(shown(result.scenarios.charge[target].allBase[pull])));
      assert.ok(html.includes(shown(result.scenarios.point[target].allBonus[pull])));
    }
    assert.ok(html.includes(`${result.scenarios.charge[target].expectedPullsToAllBonus.toFixed(1)}連`));
  }
});

test('有利な側にだけ印が付く', () => {
  const result = calculateFestival();
  const html = renderFestival(result);
  // 3名200連は呼出ポイントが優位、期待回数は呼出チャージが優位。
  assert.ok(result.scenarios.point[3].allBase[200] > result.scenarios.charge[3].allBase[200]);
  assert.ok(result.scenarios.charge[3].expectedPullsToAllBonus < result.scenarios.point[3].expectedPullsToAllBonus);
  assert.match(html, /<b class="best">50\.62%<\/b>/);
  assert.match(html, /<b class="best">270\.2連<\/b>/);
  // 100%同士など差がない組は印を付けない。
  assert.doesNotMatch(html, /<b class="best">100\.00%<\/b>/);
});

test('呼出ポイントは200連ごとに必ず1名分のボーナスを増やす', () => {
  const { curves } = runFestivalDp(4, { useCharge: false, useExchange: true });
  assert.ok(curves.expectedBonus[200] >= 1 - 1e-12);
  assert.ok(curves.expectedBonus[400] >= 2 - 1e-12);
  assert.ok(curves.expectedBonus[600] >= 3 - 1e-12);
  assert.ok(Math.abs(curves.allBonus[800] - 1) < 1e-12);
});
