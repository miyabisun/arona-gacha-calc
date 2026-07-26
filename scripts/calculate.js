#!/usr/bin/env node

/**
 * ブルーアーカイブ新募集仕様の厳密確率計算。
 *
 * 状態 (獲得済み人数, 呼び出しチャージ) ごとの確率質量を、1募集ずつ
 * 全分岐させる。乱数や丸めた百分率は計算に使わない。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_PULLS = 300;
const NORMAL_PU_RATE = 0.007;
const MILESTONES = [50, 99, 100, 150, 199, 200, 250, 299, 300];
const OUTPUT_DIR = path.join(__dirname, '..', 'docs');

function puRate(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 1;
  return NORMAL_PU_RATE;
}

function singleCycleDistribution(maxPulls) {
  const exact = Array(maxPulls + 1).fill(0);
  let alive = new Map([[0, 1]]);

  for (let pull = 1; pull <= maxPulls; pull += 1) {
    const next = new Map();
    for (const [charge, mass] of alive) {
      const success = puRate(charge);
      exact[pull] += mass * success;
      if (success < 1) {
        next.set(charge + 1, (next.get(charge + 1) ?? 0) + mass * (1 - success));
      }
    }
    alive = next;
  }

  const cumulative = Array(maxPulls + 1).fill(0);
  for (let i = 1; i <= maxPulls; i += 1) cumulative[i] = cumulative[i - 1] + exact[i];
  return { exact, cumulative };
}

function stateDynamicProgram(maxPulls) {
  // 2人獲得は吸収状態。未達成状態だけチャージを保持する。
  let states = new Map([['0:0', 1]]);
  const rows = [{ pull: 0, zero: 1, one: 0, two: 0, completedExactly: 0 }];
  let absorbed = 0;
  let maxMassError = 0;

  for (let pull = 1; pull <= maxPulls; pull += 1) {
    const next = new Map();
    let completedExactly = 0;

    for (const [key, mass] of states) {
      const [owned, charge] = key.split(':').map(Number);
      const success = puRate(charge);
      const successMass = mass * success;
      const failureMass = mass * (1 - success);

      if (owned + 1 === 2) completedExactly += successMass;
      else next.set(`${owned + 1}:0`, (next.get(`${owned + 1}:0`) ?? 0) + successMass);

      if (failureMass > 0) {
        next.set(`${owned}:${charge + 1}`, (next.get(`${owned}:${charge + 1}`) ?? 0) + failureMass);
      }
    }

    absorbed += completedExactly;
    states = next;
    let zero = 0;
    let one = 0;
    for (const [key, mass] of states) {
      if (key.startsWith('0:')) zero += mass;
      else one += mass;
    }
    maxMassError = Math.max(maxMassError, Math.abs(zero + one + absorbed - 1));
    rows.push({ pull, zero, one, two: absorbed, completedExactly });
  }
  return { rows, maxMassError };
}

function convolutionCompletion(single, maxPulls) {
  const exact = Array(maxPulls + 1).fill(0);
  const byFirstPull = {};
  for (let total = 2; total <= maxPulls; total += 1) {
    for (let first = 1; first < total; first += 1) {
      exact[total] += single.exact[first] * single.exact[total - first];
    }
  }
  const cumulative = Array(maxPulls + 1).fill(0);
  for (let i = 1; i <= maxPulls; i += 1) cumulative[i] = cumulative[i - 1] + exact[i];

  for (const limit of [200, 300]) {
    byFirstPull[limit] = [];
    for (let first = 1; first < limit; first += 1) {
      const probability = single.exact[first] * single.cumulative[limit - first];
      if (probability > 0) byFirstPull[limit].push({ firstPull: first, probability });
    }
  }
  return { exact, cumulative, byFirstPull };
}

function pct(value, digits = 6) {
  return `${(value * 100).toFixed(digits)}%`;
}

function bucketBreakdown(entries, limit) {
  const buckets = [];
  for (let start = 1; start < limit; start += 25) {
    const end = Math.min(start + 24, limit - 1);
    const probability = entries
      .filter(({ firstPull }) => firstPull >= start && firstPull <= end)
      .reduce((sum, item) => sum + item.probability, 0);
    buckets.push({ range: `${start}–${end}`, probability });
  }
  return buckets;
}

function renderHtml(result) {
  const milestoneRows = result.milestones.map((row) => `
            <tr><th>${row.pull}</th><td>${pct(row.zero)}</td><td>${pct(row.one)}</td><td class="answer">${pct(row.two)}</td><td>${pct(row.completedExactly)}</td></tr>`).join('');
  const breakdownTables = [200, 300].map((limit) => {
    const rows = bucketBreakdown(result.completionByFirstPull[String(limit)], limit)
      .map((item) => `<tr><th>${item.range}</th><td>${pct(item.probability)}</td></tr>`).join('');
    return `<section><h3>${limit}連以内に2人獲得：1人目の獲得時点別寄与</h3><table><thead><tr><th>1人目を引いた募集</th><th>最終確率への寄与</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>合計</th><td class="answer">${pct(result.summary[String(limit)].newTwoPUs)}</td></tr></tfoot></table></section>`;
  }).join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ブルーアーカイブ 新募集仕様の確率</title>
<style>
:root{color-scheme:light;--ink:#172133;--muted:#607089;--line:#cfdeeb;--blue:#087fc4;--cyan:#14bde5;--paper:#fbfdff;--pale:#eaf8ff}*{box-sizing:border-box}body{margin:0;background-color:#edf5fa;background-image:linear-gradient(#8fb5ca1a 1px,transparent 1px),linear-gradient(90deg,#8fb5ca1a 1px,transparent 1px);background-size:28px 28px;color:var(--ink);font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;line-height:1.75}body:before{content:"";position:fixed;inset:0 0 auto;height:5px;background:linear-gradient(90deg,var(--blue),var(--cyan) 65%,#ffd86a);z-index:2}main{width:min(100% - 32px,980px);margin:54px auto}header,section{position:relative;background:#fbfdfff5;border:1px solid var(--line);padding:28px 30px;margin:0 0 22px;box-shadow:10px 10px 0 #8eb8ce1c}header:after,section:after{content:"";position:absolute;width:11px;height:11px;right:12px;top:12px;border-top:2px solid var(--cyan);border-right:2px solid var(--cyan)}h1{font-family:"Yu Mincho","Hiragino Mincho ProN",serif;font-size:clamp(1.65rem,4vw,2.6rem);letter-spacing:.035em;line-height:1.35;margin:0 0 8px}h2{margin-top:0;font-size:1.28rem;letter-spacing:.04em;border-left:5px solid var(--cyan);padding-left:12px}h3{font-size:1.05rem;margin-top:0}.lead{color:var(--muted);margin:0;max-width:48rem}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:26px}.card{position:relative;background:linear-gradient(135deg,var(--pale),#fff);border:1px solid #cbe8f5;padding:17px;overflow:hidden}.card:after{content:"";position:absolute;width:56px;height:56px;right:-29px;bottom:-29px;border:8px solid #11bce51f;transform:rotate(45deg)}.card strong{display:block;color:var(--blue);font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:1.85rem;letter-spacing:-.04em;line-height:1.25}.card small{color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-family:ui-monospace,"SFMono-Regular",Consolas,"Yu Gothic",monospace;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child{text-align:left}tbody tr:hover{background:#e8f7ff80}thead th{color:var(--muted);font-size:.83rem;letter-spacing:.02em;border-bottom:2px solid #9ecfe5}.answer{font-weight:800;color:var(--blue);background:#e7f8ff80}code{background:#e7f0f6;padding:.15em .38em;border-radius:2px}ul{padding-left:1.4em}.note{color:var(--muted);font-size:.9rem}footer{text-align:center;color:var(--muted);font-family:ui-monospace,monospace;font-size:.8rem;padding:8px;letter-spacing:.04em}@media(prefers-reduced-motion:no-preference){header,.cards,section{animation:reveal .55s both}section:nth-of-type(2){animation-delay:.08s}section:nth-of-type(3){animation-delay:.14s}@keyframes reveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}@media(max-width:600px){main{margin:24px auto}header,section{padding:20px 18px;box-shadow:5px 5px 0 #8eb8ce1c}th,td{padding:8px}}
</style></head><body><main>
<header><h1>新募集仕様でPU 2人を獲得できる確率</h1><p class="lead">各PUを0.7%の募集で順番に狙い、PU獲得時に呼び出しチャージを0へ戻す前提の厳密計算です。率が提示されていない、現在狙っていない別PUのすり抜け獲得は数えません。</p><div class="cards"><div class="card"><small>新仕様・200連以内</small><strong>${pct(result.summary['200'].newTwoPUs)}</strong><span>PU 2人を獲得</span></div><div class="card"><small>新仕様・300連以内</small><strong>${pct(result.summary['300'].newTwoPUs)}</strong><span>PU 2人を獲得</span></div><div class="card"><small>旧仕様・200連</small><strong>${pct(result.oldRule.withExchange)}</strong><span>1人以上自引き＋もう1人交換</span></div></div></header>
<section><h2>単純計算との差</h2><div class="table-wrap"><table><thead><tr><th>見方</th><th>確率</th></tr></thead><tbody><tr><th>1人を100連以内に獲得</th><td>${pct(result.simpleComparison.oneWithin100)}</td></tr><tr><th>100連を独立に2回、と区切る単純計算</th><td>${pct(result.simpleComparison.twoFixedWindows)}</td></tr><tr><th>余った募集回数も全て次のPUへ回す厳密計算</th><td class="answer">${pct(result.summary['200'].newTwoPUs)}</td></tr><tr><th>単純計算から拾い直した確率</th><td class="answer">+${pct(result.simpleComparison.recoveredByFlexibleSplit)}</td></tr></tbody></table></div><p>例えば、1人目を50連以内に獲得して最終的に200連以内で2人揃う経路だけで、全体へ <strong>${pct(result.simpleComparison.firstWithin50ContributionAt200)}</strong> 寄与します。1人目が早ければ、残りを固定100連で打ち切らず、2人目へすべて使える効果を含みます。</p></section>
<section><h2>募集回数ごとの全確率</h2><div class="table-wrap"><table><thead><tr><th>募集回数</th><th>0人</th><th>ちょうど1人</th><th>2人獲得済み</th><th>その回で2人目</th></tr></thead><tbody>${milestoneRows}</tbody></table></div><p class="note">各行の「0人＋ちょうど1人＋2人獲得済み」は100%です。表示のみ小数第6位に丸めています。</p></section>
${breakdownTables}
<section><h2>網羅性と再現方法</h2><ul><li><code>calculate.js</code> は、各募集前の「獲得済み人数 × チャージ（0〜199）」を状態として、成功・失敗の両方へ確率質量を分配します。</li><li>チャージ99では成功率50%、199では100%、その他では0.7%。成功時は次のPUへ進みチャージ0、失敗時はチャージを1増やします。</li><li>独立に求めた「1人を引くまでの所要回数分布」を2回畳み込む別計算とも照合しています。最大差は ${result.audit.maxCrossCheckDifference.toExponential(3)}、確率質量の最大誤差は ${result.audit.maxMassError.toExponential(3)} でした。</li><li><code>node calculate.js</code> で <code>results.json</code> とこのHTMLを再生成できます。JSONには1〜300連の全行と、1人目を引いた個々の回（1連目、2連目…）ごとの寄与を収録しています。</li></ul></section>
<section><h2>比較上の注意</h2><p>旧仕様の数値は「200回でPUを1人以上自引きできる確率」<code>1 − 0.993²⁰⁰</code> です。自引きできたとき、蓄積した200ポイントで別PUを交換できるため、これが2人獲得確率になります。新仕様には交換ポイントを加算していません。</p></section>
<footer><a href="simulation.html">モンテカルロ新旧比較を開く</a><br>Generated by scripts/calculate.js — deterministic dynamic programming</footer></main></body></html>`;
}

function calculate() {
  const single = singleCycleDistribution(MAX_PULLS);
  const dp = stateDynamicProgram(MAX_PULLS);
  const convolution = convolutionCompletion(single, MAX_PULLS);
  const maxCrossCheckDifference = Math.max(...dp.rows.map((row) => Math.abs(row.two - convolution.cumulative[row.pull])));
  const oldWithExchange = 1 - ((1 - NORMAL_PU_RATE) ** 200);
  const oneWithin100 = single.cumulative[100];
  const firstWithin50ContributionAt200 = convolution.byFirstPull[200]
    .filter(({ firstPull }) => firstPull <= 50)
    .reduce((sum, item) => sum + item.probability, 0);

  const result = {
    assumptions: {
      normalPuRate: NORMAL_PU_RATE,
      rateAtCharge99: 0.5,
      rateAtCharge199: 1,
      chargeResetsOnPu: true,
      targetCount: 2,
      nonTargetPuSpooksCounted: false,
      interpretation: '2人のPUを順に狙い、対象PUを得るたびチャージを0へ戻す',
    },
    summary: {
      200: { newTwoPUs: dp.rows[200].two },
      300: { newTwoPUs: dp.rows[300].two },
    },
    oldRule: { pulls: 200, atLeastOneNaturalPu: oldWithExchange, withExchange: oldWithExchange },
    simpleComparison: {
      oneWithin100,
      twoFixedWindows: oneWithin100 ** 2,
      recoveredByFlexibleSplit: dp.rows[200].two - (oneWithin100 ** 2),
      firstWithin50ContributionAt200,
    },
    milestones: MILESTONES.map((pull) => dp.rows[pull]),
    allPulls: dp.rows,
    singlePuCycle: { exactByPull: single.exact, cumulativeByPull: single.cumulative },
    completionByFirstPull: convolution.byFirstPull,
    audit: { method: 'state dynamic programming cross-checked by convolution', maxMassError: dp.maxMassError, maxCrossCheckDifference },
  };

  if (dp.maxMassError > 1e-12 || maxCrossCheckDifference > 1e-12) {
    throw new Error(`検算に失敗: mass=${dp.maxMassError}, cross-check=${maxCrossCheckDifference}`);
  }

  return result;
}

function main() {
  const result = calculate();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), renderHtml(result));
  console.log(`新仕様 200連以内: ${pct(result.summary['200'].newTwoPUs)}`);
  console.log(`新仕様 300連以内: ${pct(result.summary['300'].newTwoPUs)}`);
  console.log(`旧仕様 200連＋交換: ${pct(result.oldRule.withExchange)}`);
  console.log(`検算最大差: ${result.audit.maxCrossCheckDifference.toExponential(3)}`);
}

if (require.main === module) main();

module.exports = { calculate, puRate, singleCycleDistribution, stateDynamicProgram, convolutionCompletion };
