#!/usr/bin/env node

/**
 * フェス限ページの正準数値を1コマンドで出力する。
 * 記事の数値を確認・引用するときはこれを実行する。アドホックな再計算スクリプトを書かないこと。
 */

const calc = require('../scripts/festival-calc.js');

const r = calc.calculateFestival();
const b = r.banking;
const stone = (pulls) => Math.round(pulls * calc.PYROXENE_PER_PULL).toLocaleString('ja-JP');

console.log('=== 掘り効率(補填込み) ===');
console.log(`  基準(素の200文字/90連): ${b.lettersPerPull.toFixed(4)} 文字/連`);
console.log(`  平常時掘り(+50欠片/10連): ${b.chaseRate.toFixed(4)} 文字/連`);
console.log(`  フェス限掘り(+80欠片/10連): ${b.chaseRateFes.toFixed(4)} 文字/連`);
console.log(`  フェス限の欠片副産物: ${calc.FES_BYPRODUCT_PER_PULL.toFixed(2)} 文字/連`);

console.log('\n=== 結論(タブ別・戦略別) ===');
for (const t of calc.TARGETS) {
  const charge = r.retreat[t].withSpook;
  const plans = t === 2 ? [['focus', '']] : [['focus', '対イロハ集中'], ['sequential', '対引けたら次へ']];
  for (const [id, label] of plans) {
    const p = r.blockRun[t][id];
    const saved = p.pulls - charge.expectedPulls;
    const lost = (p.letters - charge.letters) + saved * calc.FES_BYPRODUCT_PER_PULL;
    const net = saved * b.chaseRateFes - lost;
    console.log(`  ${t}PU ${label}: 節約${stone(saved)}石(${saved.toFixed(1)}連) 文字減${Math.round(lost)} → 差引${net >= 0 ? '+' : ''}${Math.round(net)}文字 ${net >= 0 ? 'チャージ優位' : 'ポイント優位'}`);
  }
}

console.log('\n=== 呼出チャージ(素体そろえて撤退) ===');
for (const t of calc.TARGETS) {
  const w = r.retreat[t].withSpook;
  const wo = r.retreat[t].withoutSpook;
  console.log(`  ${t}PU: 期待${w.expectedPulls.toFixed(1)}連/${Math.round(w.letters)}文字 (指名のみなら${wo.expectedPulls.toFixed(1)}連/${Math.round(wo.letters)}文字, すり抜け決着${(w.finishedViaSpook * 100).toFixed(2)}%)`);
}

console.log('\n=== 呼出ポイント(ブロック運用) ===');
for (const t of calc.TARGETS) {
  for (const [id, label] of [['focus', 'イロハ連打'], ['sequential', 'PU切替 ']]) {
    const p = r.blockRun[t][id];
    const blocks = p.blocks.filter((x) => x.stopHere > 0.0005)
      .map((x) => `${x.pulls}連${(x.stopHere * 100).toFixed(1)}%(${Math.round(x.lettersHere)}文字)`).join(' / ');
    console.log(`  ${t}PU ${label}: ${blocks} | 期待${p.pulls.toFixed(1)}連 ${Math.round(p.letters)}文字`);
  }
}

console.log('\n=== 2PU 200連時点の分岐 ===');
const tb = r.twoPuBranch;
console.log(`  両方そろう ${(tb.bothArrived * 100).toFixed(1)}% / イロハのみ ${(tb.exchangeForPartner * 100).toFixed(1)}% / イブキのみ ${(tb.exchangeForMain * 100).toFixed(1)}% / 残業 ${(tb.overtime * 100).toFixed(1)}%`);

console.log('\n=== 99連持ち越し ===');
console.log(`  期待短縮${b.expectedSaving.toFixed(1)}連 / 持ち出し${b.carryPulls.toFixed(1)}連(${stone(b.carryPulls)}石)`);
console.log(`  台帳: 支出${b.costLetters.toFixed(0)}文字 vs 受取${b.lettersTotal.toFixed(0)}文字 (指名${b.lettersFromNamed.toFixed(0)} + 欠片一括${b.lettersFromFesShards.toFixed(0)} + プール${b.lettersFromPool.toFixed(0)})`);
console.log(`  カウンタ保持率${(b.survivalToBank * 100).toFixed(2)}% / 出たら止めの純コスト${b.stopOnHitCost.toFixed(1)}連`);
