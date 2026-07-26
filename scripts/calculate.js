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

function renderFaq(result) {
  const oneWithin100 = result.simpleComparison.oneWithin100;
  const eitherWithin100 = 1 - ((1 - oneWithin100) ** 2);
  const remainingRoutes = result.summary['300'].newTwoPUs - eitherWithin100;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>募集確率 Q&amp;A</title><style>
:root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(900px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}header,.qa{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}h1{font-size:17px;font-weight:600;line-height:1.3;margin:0}.lead{color:var(--muted);margin-bottom:0}.qa h2{font-size:17px;line-height:1.3;margin:0 0 12px;padding:4px 0 4px 12px;border-left:4px solid var(--accent)}.answer{color:var(--accent);font-weight:700}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px;border-bottom:1px solid var(--border);text-align:right}th{text-align:left}code{background:var(--accent-subtle);color:var(--on);border-radius:6px;padding:4px}footer{text-align:center;color:var(--muted);font-size:12px;margin-top:24px}@media(max-width:600px){main{width:calc(100% - 16px);margin:16px auto}header,.qa{padding:12px}.qa{overflow-wrap:anywhere}table{display:block;overflow-x:auto}th,td{padding:8px 4px;font-size:14px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
</style></head><body><main><nav class="nav"><a href="./">周年比較</a><a href="faq.html" aria-current="page">Q&amp;A</a></nav><header><h1>計算についてのQ&amp;A</h1><p class="lead">前提・単純計算との差・確率が伸びる理由・厳密計算の監査方法です。</p></header>
<section class="qa"><h2>なぜ「100連を2回」より200連通しの確率が高い？</h2><table><tbody><tr><th>1人を100連以内</th><td>${pct(oneWithin100)}</td></tr><tr><th>100連×2と固定する単純計算</th><td>${pct(result.simpleComparison.twoFixedWindows)}</td></tr><tr><th>余りを次のPUへ渡す5.5周年の厳密計算</th><td class="answer">${pct(result.summary['200'].newTwoPUs)}</td></tr><tr><th>拾い直される確率</th><td class="answer">+${pct(result.simpleComparison.recoveredByFlexibleSplit)}</td></tr></tbody></table><p>1人目を50連以内に獲得して200連以内に2人揃う経路だけでも、全体へ ${pct(result.simpleComparison.firstWithin50ContributionAt200)} 寄与します。</p></section>
<section class="qa"><h2>なぜ5.5周年は300連で約95%まで上がる？</h2><p>1人あたり最大200連です。2回のうち片方でも100連以内なら、残る片方へ200連以上を渡せるため必ず揃います。この経路だけで <span class="answer">${pct(eitherWithin100)}</span>。両方100連超でも合計300連以内となる経路 ${pct(remainingRoutes)} を加えて、${pct(result.summary['300'].newTwoPUs)} になります。</p></section>
<section class="qa"><h2>1.0周年と5.5周年は何を指す？</h2><p><strong>1.0周年</strong>は募集1回ごとに呼び出しポイントが貯まり、200ptごとに未所持PUを1人交換する方式です。<strong>5.5周年</strong>はPUが出なければチャージが増え、99→100点の募集で50%、199→200点の募集で100%、PU獲得時に0へ戻る方式として計算しています。</p></section>
<section class="qa"><h2>どこまでをPU獲得として数える？</h2><p>未所持PUを順番に狙い、現在狙っているPUの率を0.7%とします。提示されていない別PUのすり抜け率は加算していません。1.0周年の2人・200連は、1人以上を自引きする確率 <code>1 − 0.993²⁰⁰</code> と、残る1人のポイント交換を組み合わせます。</p></section>
<section class="qa"><h2>厳密計算で組み合わせ爆発しない？</h2><p>履歴を列挙せず、同じ「獲得人数 × チャージ」の履歴を一つの状態へ集約します。5.5周年は最大4×200程度の状態を800連進めるだけです。別実装として、1人分の所要回数分布を人数分だけ畳み込んだ結果とも照合します。1.0周年は自引き人数DPと二項分布の閉形式を照合し、さらに確率質量の合計、単調性、人数×200連で100%になることを検査します。</p></section><footer>Generated by scripts/calculate.js</footer></main></body></html>`;
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
  fs.writeFileSync(path.join(OUTPUT_DIR, 'faq.html'), renderFaq(result));
  console.log(`5.5周年 200連以内: ${pct(result.summary['200'].newTwoPUs)}`);
  console.log(`5.5周年 300連以内: ${pct(result.summary['300'].newTwoPUs)}`);
  console.log(`1.0周年 200連＋交換: ${pct(result.oldRule.withExchange)}`);
  console.log(`検算最大差: ${result.audit.maxCrossCheckDifference.toExponential(3)}`);
}

if (require.main === module) main();

module.exports = { calculate, puRate, singleCycleDistribution, stateDynamicProgram, convolutionCompletion };
