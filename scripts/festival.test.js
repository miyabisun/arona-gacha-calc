const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateComparison } = require('./compare.js');
const {
  calculateFestival,
  renderFestival,
  runFestivalDp,
  chargeHitRate,
  chargeResidual,
  shardsToLetters,
  SPOOK_EACH_RATE,
  MAX_PULLS,
  TARGETS,
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
        `呼び出しチャージ ${target}人 ${pull}連で不一致`,
      );
      assert.ok(
        Math.abs(festival.scenarios.point[target].allBonus[pull] - comparison.curves.anniversary1_0[target][pull]) < 1e-12,
        `呼び出しポイント ${target}人 ${pull}連で不一致`,
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

test('呼び出しチャージを99まで貯めた状態では最初の募集で50%を得る', () => {
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

  for (const html of [japanese, english]) {
    // すべての表が列幅を固定し、横スクロールに頼らないこと。
    const tables = (html.match(/<table>/g) ?? []).length;
    assert.equal((html.match(/<colgroup>/g) ?? []).length, tables);
    assert.doesNotMatch(html, /table-wrap|overflow-x/);
  }
});

test('文字は経路ごとの報酬を積み上げた値になる', () => {
  // 1名だけ狙えば、すり抜け待ちの相手がいないので初回ボーナスと重複だけが積まれる。
  const { curves } = runFestivalDp(1, { useCharge: false, useExchange: false });
  assert.ok(Math.abs(curves.letters[1] - 0.007 * 100) < 1e-12);
  assert.equal(curves.shards[1], 0);
  // 200連の交換は未所持なら初回ボーナス100文字、既所持なら重複100＋ボーナス100＋50欠片。
  const exchanged = runFestivalDp(1, { useCharge: false, useExchange: true });
  assert.ok(exchanged.curves.letters[200] > curves.letters[200]);
  assert.ok(exchanged.curves.allBonus[200] >= 1 - 1e-12);
});

test('文字と欠片は単調非減少で、呼び出しポイントが上回る', () => {
  const result = calculateFestival();
  for (const target of TARGETS) {
    const charge = result.scenarios.charge[target];
    const point = result.scenarios.point[target];
    for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
      assert.ok(charge.letters[pull] >= charge.letters[pull - 1] - 1e-12);
      assert.ok(point.shards[pull] >= point.shards[pull - 1] - 1e-12);
    }
    // 自引きと交換が独立に走るぶん、200連以降は呼び出しポイントの文字が多い。
    for (const pull of [200, 400, 600]) {
      assert.ok(point.letters[pull] > charge.letters[pull], `${target}人 ${pull}連で逆転`);
    }
  }
});

test('欠片は安い段から順に文字へ換算する', () => {
  assert.equal(shardsToLetters(0), 0);
  assert.equal(shardsToLetters(20), 20);        // 1:1 の20文字ぶん
  assert.equal(shardsToLetters(50), 35);        // 20文字 + 残り30欠片で15文字
  assert.equal(shardsToLetters(200), 80);       // 1:4 の段まで使い切る
  assert.equal(shardsToLetters(300), 100);      // 以降は5欠片で1文字
});

test('生成ページの数値が計算結果と一致する', () => {
  const result = calculateFestival();
  const html = renderFestival(result);
  for (const target of TARGETS) {
    // 撤退シナリオ: すり抜けの有無で期待連数と文字が並ぶ。
    const retreat = result.retreat[target];
    assert.ok(html.includes(`${retreat.withSpook.expectedPulls.toFixed(1)}連`), `${target}PU すり抜けあり期待連数`);
    assert.ok(html.includes(`${retreat.withoutSpook.expectedPulls.toFixed(1)}連`), `${target}PU すり抜けなし期待連数`);
    assert.ok(html.includes(`${Math.round(retreat.withoutSpook.letters)}文字`), `${target}PU PU対象だけの文字`);
    // ブロック運用: 進め方ごとの期待消費と文字。
    for (const plan of ['focus', 'sequential']) {
      const row = result.blockRun[target][plan];
      assert.ok(html.includes(`${Math.round(row.letters)}文字`), `${target}PU ${plan} の文字`);
      assert.ok(html.includes(`${Math.round(row.pulls * 120).toLocaleString('ja-JP')}石`), `${target}PU ${plan} の石`);
    }
  }
  // 2PUの呼び出しポイント節は200連時点の4分岐を確率つきで出す。
  const branch = result.twoPuBranch;
  for (const value of [branch.bothArrived, branch.exchangeForPartner, branch.exchangeForMain, branch.overtime]) {
    assert.ok(html.includes(`${(value * 100).toFixed(1)}%`), `分岐 ${(value * 100).toFixed(1)}%`);
  }
});

test('有利な側にだけ印が付く', () => {
  const result = calculateFestival();
  const html = renderFestival(result);
  // 呼び出しチャージ表: すり抜け込のほうが期待連数が短く、PU対象だけのほうが文字が多い。
  assert.match(html, /class="best">172\.6連/);
  assert.match(html, /class="best">200文字/);
  // 呼び出しポイントの分岐表では最頻の「イロハ自引きのみ」に印が付く。
  assert.ok(result.twoPuBranch.exchangeForPartner > result.twoPuBranch.overtime);
  assert.match(html, new RegExp(`class="best">${(result.twoPuBranch.exchangeForPartner * 100).toFixed(1)}%`));
  assert.ok((html.match(/class="best"/g) ?? []).length >= 6);
});

test('呼び出しポイントは200連ごとに必ず1名分のボーナスを増やす', () => {
  const { curves } = runFestivalDp(4, { useCharge: false, useExchange: true });
  assert.ok(curves.expectedBonus[200] >= 1 - 1e-12);
  assert.ok(curves.expectedBonus[400] >= 2 - 1e-12);
  assert.ok(curves.expectedBonus[600] >= 3 - 1e-12);
  assert.ok(Math.abs(curves.allBonus[800] - 1) < 1e-12);
});
