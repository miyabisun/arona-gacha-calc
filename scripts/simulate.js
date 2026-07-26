#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const NORMAL_RATE = 0.007;
const MAX_PULLS = 800;
const DEFAULT_TRIALS = 1_000_000;
const SEED = [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344];
const TARGETS = [1, 2, 3, 4];
const OUTPUT_DIR = path.join(__dirname, '..', 'docs');

function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

// xoshiro128**: 固定シードの再現可能な32bit擬似乱数列。
function xoshiro128ss(seed) {
  let [a, b, c, d] = seed.map((value) => value >>> 0);
  return () => {
    const result = Math.imul(rotateLeft(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotateLeft(d, 11);
    return result / 0x1_0000_0000;
  };
}

function rateForCharge(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 1;
  return NORMAL_RATE;
}

function histograms() {
  return Object.fromEntries(TARGETS.map((target) => [target, Array(MAX_PULLS + 1).fill(0)]));
}

function simulateNew(trials, random) {
  const exactCompletionCounts = histograms();
  for (let trial = 0; trial < trials; trial += 1) {
    let owned = 0;
    let charge = 0;
    for (let pull = 1; pull <= MAX_PULLS && owned < 4; pull += 1) {
      const rate = rateForCharge(charge);
      if (rate === 1 || random() < rate) {
        owned += 1;
        charge = 0;
        if (exactCompletionCounts[owned]) exactCompletionCounts[owned][pull] += 1;
      } else {
        charge += 1;
      }
    }
  }
  return exactCompletionCounts;
}

function oldCompletionPull(naturalPulls, target) {
  let earliest = Infinity;
  // j回交換する候補。j=0も「すべて自引き」の候補として扱う。
  for (let exchanges = 0; exchanges <= MAX_PULLS / 200; exchanges += 1) {
    const naturalNeeded = target - exchanges;
    if (naturalNeeded < 0) continue;
    const naturalReady = naturalNeeded === 0 ? 0 : naturalPulls[naturalNeeded - 1];
    if (naturalReady === undefined) continue;
    const exchangeReady = exchanges * 200;
    const completion = Math.max(naturalReady, exchangeReady);
    if (completion <= MAX_PULLS) earliest = Math.min(earliest, completion);
  }
  return earliest;
}

function simulateOld(trials, random) {
  const exactCompletionCounts = histograms();
  for (let trial = 0; trial < trials; trial += 1) {
    const naturalPulls = [];
    for (let pull = 1; pull <= MAX_PULLS && naturalPulls.length < 4; pull += 1) {
      if (random() < NORMAL_RATE) naturalPulls.push(pull);
    }
    for (const target of TARGETS) {
      const completion = oldCompletionPull(naturalPulls, target);
      if (Number.isFinite(completion)) exactCompletionCounts[target][completion] += 1;
    }
  }
  return exactCompletionCounts;
}

function cumulativeProbabilities(counts, trials) {
  const curves = {};
  for (const target of TARGETS) {
    let cumulative = 0;
    curves[target] = counts[target].map((count) => {
      cumulative += count;
      return cumulative / trials;
    });
  }
  return curves;
}

function exactNewCurves() {
  let state = new Map([['0:0', 1]]);
  const curves = Object.fromEntries(TARGETS.map((target) => [target, Array(MAX_PULLS + 1).fill(0)]));
  const absorbed = Array(5).fill(0);
  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const next = new Map();
    for (const [key, mass] of state) {
      const [owned, charge] = key.split(':').map(Number);
      const rate = rateForCharge(charge);
      const successMass = mass * rate;
      const failedMass = mass * (1 - rate);
      const nextOwned = owned + 1;
      if (nextOwned >= 4) absorbed[4] += successMass;
      else next.set(`${nextOwned}:0`, (next.get(`${nextOwned}:0`) ?? 0) + successMass);
      if (failedMass) next.set(`${owned}:${charge + 1}`, (next.get(`${owned}:${charge + 1}`) ?? 0) + failedMass);
    }
    state = next;
    const massByOwned = Array(5).fill(0);
    massByOwned[4] = absorbed[4];
    for (const [key, mass] of state) massByOwned[Number(key.split(':', 1)[0])] += mass;
    for (const target of TARGETS) {
      curves[target][pull] = massByOwned.slice(target).reduce((sum, mass) => sum + mass, 0);
    }
  }
  return curves;
}

function exactOldCurves() {
  const curves = Object.fromEntries(TARGETS.map((target) => [target, Array(MAX_PULLS + 1).fill(0)]));
  let natural = [1, 0, 0, 0, 0];
  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const next = Array(5).fill(0);
    for (let owned = 0; owned <= 4; owned += 1) {
      next[owned] += natural[owned] * (owned === 4 ? 1 : 1 - NORMAL_RATE);
      if (owned < 4) next[owned + 1] += natural[owned] * NORMAL_RATE;
    }
    natural = next;
    const exchanges = Math.floor(pull / 200);
    for (const target of TARGETS) {
      curves[target][pull] = natural.reduce((sum, mass, owned) => sum + (owned + exchanges >= target ? mass : 0), 0);
    }
  }
  return curves;
}

function dkwErrorBound(trials, alpha = 0.05) {
  return Math.sqrt(Math.log(2 / alpha) / (2 * trials));
}

function maxDifference(estimated, exact) {
  let maximum = 0;
  for (const target of TARGETS) {
    for (let pull = 0; pull <= MAX_PULLS; pull += 1) {
      maximum = Math.max(maximum, Math.abs(estimated[target][pull] - exact[target][pull]));
    }
  }
  return maximum;
}

function runSimulation(trials = DEFAULT_TRIALS) {
  const newRandom = xoshiro128ss(SEED);
  const oldRandom = xoshiro128ss(SEED.map((value, index) => (value ^ (0x9e3779b9 * (index + 1))) >>> 0));
  const newEstimated = cumulativeProbabilities(simulateNew(trials, newRandom), trials);
  const oldEstimated = cumulativeProbabilities(simulateOld(trials, oldRandom), trials);
  const newExact = exactNewCurves();
  const oldExact = exactOldCurves();
  const uniform95 = dkwErrorBound(trials);
  const audit = {
    newMaxAbsoluteDifference: maxDifference(newEstimated, newExact),
    oldMaxAbsoluteDifference: maxDifference(oldEstimated, oldExact),
  };
  return {
    metadata: {
      trials,
      seed: SEED.map((value) => `0x${value.toString(16).padStart(8, '0')}`),
      maxPulls: MAX_PULLS,
      normalPuRate: NORMAL_RATE,
      confidence: 0.95,
      dkwUniformErrorBound: uniform95,
      tenThousandTrialDkwBound: dkwErrorBound(10_000),
      method: 'Monte Carlo, one pull at a time, fixed-seed xoshiro128**',
      sources: [
        { title: 'Massart (1990), The Tight Constant in the DKW Inequality', url: 'https://doi.org/10.1214/aop/1176990746' },
        { title: 'NIST: Proportion Confidence Interval', url: 'https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/propconf.htm' },
      ],
    },
    assumptions: {
      fivePointFiveAnniversary: '対象PUを順に狙う。通常0.7%、チャージ99で50%、199で100%。獲得時チャージ0。',
      onePointZeroAnniversary: '対象PUを順に通常0.7%で狙い、各制限回数の終了後にfloor(募集回数/200)人まで未所持PUを交換。',
      nonTargetPuSpooksCounted: false,
    },
    monteCarlo: { new: newEstimated, old: oldEstimated },
    exactAudit: { new: newExact, old: oldExact, ...audit },
  };
}

function pct(value, digits = 3) {
  return `${(value * 100).toFixed(digits)}%`;
}

function points(value, digits = 3) {
  return `${(value * 100).toFixed(digits)}ポイント`;
}

function chartPath(values, maxPulls, width = 920, height = 430) {
  const left = 58; const right = 18; const top = 18; const bottom = 42;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  return values.slice(0, maxPulls + 1).map((value, pull) => {
    const x = left + (pull / maxPulls) * plotWidth;
    const y = top + (1 - value) * plotHeight;
    return `${pull ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function graphSvg(result, target, maxPulls, id) {
  const width = 920; const height = 430; const left = 58; const right = 18; const top = 18; const bottom = 42;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const yLines = [0, .25, .5, .75, 1].map((value) => {
    const y = top + (1 - value) * plotHeight;
    const className = value === .75 ? 'safe' : 'horizontal';
    const label = value === .75 ? '75% SAFE' : `${value * 100}%`;
    return `<line class="${className}" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="${className}" x="${left - 10}" y="${y + 4}">${label}</text>`;
  }).join('');
  const xLines = Array.from({ length: Math.floor(maxPulls / 10) + 1 }, (_, index) => index * 10).map((pull) => {
    const x = left + (pull / maxPulls) * plotWidth;
    const major = pull % 100 === 0;
    return `<line class="${major ? 'major' : 'minor'}" x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}"/>${major ? `<text x="${x}" y="${height - 14}">${pull}</text>` : ''}`;
  }).join('');
  return `<div class="chart-shell" data-chart="${id}" data-max="${maxPulls}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${target}人を揃える累積確率の1.0周年と5.5周年比較"><g class="grid">${yLines}${xLines}</g><path class="curve one" d="${chartPath(result.monteCarlo.old[target], maxPulls)}"/><path class="curve five" d="${chartPath(result.monteCarlo.new[target], maxPulls)}"/><rect class="hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/><circle class="hover-dot one" r="5"/><circle class="hover-dot five" r="5"/></svg><output class="chart-tip"></output></div>`;
}

function renderHtml(result) {
  const chartData = JSON.stringify({
    one: { five: result.monteCarlo.new[1].slice(0, 201), one: result.monteCarlo.old[1].slice(0, 201) },
    two: { five: result.monteCarlo.new[2].slice(0, 401), one: result.monteCarlo.old[2].slice(0, 401) },
    three: { five: result.monteCarlo.new[3].slice(0, 601), one: result.monteCarlo.old[3].slice(0, 601) },
    four: { five: result.monteCarlo.new[4], one: result.monteCarlo.old[4] },
  }).replaceAll('<', '\\u003c');
  const bound = points(result.metadata.dkwUniformErrorBound, 3);
  const trialMultiplier = result.metadata.trials / 10_000;
  const graph = (target, maxPulls, id) => `<section class="panel"><div class="panel-head"><div><div class="eyebrow">${target} target${target > 1 ? 's' : ''} / ${maxPulls} pulls</div><h2>${target}人を${maxPulls}連で揃える</h2></div><div class="legend"><span><i class="five"></i>5.5周年</span><span><i class="one"></i>1.0周年</span><span class="safe-key">— 75% 安全圏</span></div></div>${graphSvg(result,target,maxPulls,id)}</section>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PU募集 1.0周年・5.5周年比較</title><style>
:root{--night:#07111f;--panel:#0d1d2d;--line:#25445b;--text:#e9f5ff;--muted:#8eabc0;--five:#49d5ff;--one:#ffcc67;--safe:#ff6078}*{box-sizing:border-box}body{margin:0;background:var(--night);color:var(--text);font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;line-height:1.7;background-image:radial-gradient(circle at 80% 5%,#174b6655,transparent 33%),linear-gradient(#17314822 1px,transparent 1px),linear-gradient(90deg,#17314822 1px,transparent 1px);background-size:auto,24px 24px,24px 24px}main{width:min(1180px,calc(100% - 30px));margin:44px auto 70px}.eyebrow{font:700 .75rem ui-monospace,monospace;color:var(--five);letter-spacing:.17em;text-transform:uppercase}.nav{display:flex;gap:18px;margin-bottom:18px}.nav a{color:var(--muted);font-size:.86rem}.nav a[aria-current]{color:var(--five)}h1{font-family:"Yu Mincho","Hiragino Mincho ProN",serif;font-size:clamp(2rem,6vw,4.5rem);line-height:1.06;letter-spacing:.02em;margin:.15em 0}.lede{color:var(--muted);max-width:62rem;font-size:1.04rem}.hero{padding:20px 0 30px}.panel{background:#0b1927ed;border:1px solid var(--line);padding:26px;margin:22px 0;box-shadow:10px 10px 0 #020b13}.panel h2{font:700 clamp(1.25rem,3vw,1.8rem) "Yu Mincho",serif;margin:0}.panel-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:12px}.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);font-size:.83rem}.legend i{display:inline-block;width:22px;height:3px;margin-right:7px;vertical-align:middle}.legend .five{background:var(--five)}.legend .one{background:var(--one)}.safe-key{color:#ff9aa9}.chart-shell{position:relative}.chart-shell svg{display:block;width:100%;height:auto}.grid line.horizontal{stroke:#244258;stroke-width:1}.grid line.minor{stroke:#2a465a;stroke-width:.6;opacity:.42}.grid line.major{stroke:#6a8496;stroke-width:1;opacity:.58}.grid line.safe{stroke:var(--safe);stroke-width:2;opacity:.58}.grid text{fill:var(--muted);font:12px ui-monospace,monospace;text-anchor:middle}.grid text.safe{fill:#ff91a2;font-weight:700;text-anchor:end}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}.curve.five{stroke:var(--five)}.curve.one{stroke:var(--one)}.hit{fill:transparent;cursor:crosshair}.hover-dot{display:none;pointer-events:none;stroke:#07111f;stroke-width:2}.hover-dot.five{fill:var(--five)}.hover-dot.one{fill:var(--one)}.chart-tip{position:absolute;display:none;pointer-events:none;background:#020a12f2;border:1px solid #5f8299;padding:8px 11px;font:12px/1.55 ui-monospace,monospace;white-space:nowrap;z-index:3}.small{font-size:.82rem;color:var(--muted)}.term{all:unset;border-bottom:1px dotted var(--five);cursor:help;position:relative}.term:after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);width:min(320px,80vw);padding:10px;background:#020a12;border:1px solid #5f8299;color:var(--text);font:12px/1.55 sans-serif;opacity:0;visibility:hidden;z-index:5}.term:hover:after,.term:focus:after{opacity:1;visibility:visible}.sources a,footer a{color:var(--five)}footer{color:var(--muted);font:12px ui-monospace,monospace;text-align:center;margin-top:34px}@media(max-width:760px){.panel{padding:15px 10px}.panel-head{display:block;padding:0 8px}.legend{margin-top:8px}.curve{stroke-width:6}.hero{padding-top:10px}.chart-tip{font-size:10px}}@media(prefers-reduced-motion:no-preference){.hero,.panel{animation:up .45s both}@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
</style></head><body><main><nav class="nav"><a href="./">厳密計算</a><a href="simulation.html" aria-current="page">周年比較</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="eyebrow">1.0 anniversary / 5.5 anniversary</div><h1>お迎え率が100%へ<br>届くまで。</h1><p class="lede">1.0周年の呼び出しポイント方式と、5.5周年の呼び出しチャージ方式を、1連ごとの累積お迎え率で比較します。赤線は75%の安全圏です。</p></header>
${graph(1,200,'one')}${graph(2,400,'two')}${graph(3,600,'three')}${graph(4,800,'four')}
<section class="panel small sources"><p><button class="term" data-tip="各試行で募集を1回ずつ進め、成功した試行の割合を累積確率として推定します。固定シードなので再実行しても同じ結果です。">モンテカルロ法</button>を使用（${result.metadata.trials.toLocaleString('ja-JP')}試行）。各曲線の1〜800連全体に対する95%一様誤差幅は <strong>±${bound}</strong>。1万試行の${trialMultiplier.toLocaleString('ja-JP')}倍です。厳密DPとの実測最大差は、5.5周年 ${points(result.exactAudit.newMaxAbsoluteDifference,3)}／1.0周年 ${points(result.exactAudit.oldMaxAbsoluteDifference,3)}。</p><p>前提：未所持PUを順に狙い、対象外PUのすり抜けは数えません。1.0周年は各時点で募集を終了した後、200ptごとに未所持1人を交換します。<a href="faq.html">計算の考え方とQ&amp;A</a></p></section><footer>Generated by scripts/simulate.js / seed ${result.metadata.seed.join(' · ')}</footer></main>
<script>const DATA=${chartData};document.querySelectorAll('[data-chart]').forEach(shell=>{const svg=shell.querySelector('svg'),hit=shell.querySelector('.hit'),tip=shell.querySelector('.chart-tip'),fiveDot=shell.querySelector('.hover-dot.five'),oneDot=shell.querySelector('.hover-dot.one'),series=DATA[shell.dataset.chart],max=Number(shell.dataset.max),left=58,right=18,top=18,bottom=42,width=920,height=430,plotWidth=width-left-right,plotHeight=height-top-bottom;const move=e=>{const r=svg.getBoundingClientRect(),svgX=(e.clientX-r.left)/r.width*width,ratio=Math.max(0,Math.min(1,(svgX-left)/plotWidth)),pull=Math.round(ratio*max),x=left+(pull/max)*plotWidth,fiveY=top+(1-series.five[pull])*plotHeight,oneY=top+(1-series.one[pull])*plotHeight;for(const [dot,y] of [[fiveDot,fiveY],[oneDot,oneY]]){dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.style.display='block'}tip.style.display='block';tip.style.left=Math.min(r.width-190,Math.max(0,(x/width)*r.width+8))+'px';tip.style.top=Math.max(0,(e.clientY-r.top)-50)+'px';tip.textContent=pull+'連  5.5周年 '+(series.five[pull]*100).toFixed(3)+'% / 1.0周年 '+(series.one[pull]*100).toFixed(3)+'%'};hit.addEventListener('pointermove',move);hit.addEventListener('pointerleave',()=>{tip.style.display='none';fiveDot.style.display='none';oneDot.style.display='none'})});</script></body></html>`;
}

function main() {
  const trials = process.env.SIM_TRIALS ? Number(process.env.SIM_TRIALS) : DEFAULT_TRIALS;
  if (!Number.isSafeInteger(trials) || trials <= 0) throw new Error('SIM_TRIALSは正の整数にしてください');
  const started = Date.now();
  const result = runSimulation(trials);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'simulation-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'simulation.html'), renderHtml(result));
  console.log(`試行回数: ${trials.toLocaleString('ja-JP')} (${((Date.now()-started)/1000).toFixed(2)}秒)`);
  for (const target of TARGETS) {
    const limit = target * 200;
    console.log(`${target}人/${limit}連 5.5周年=${pct(result.monteCarlo.new[target][limit])} 1.0周年=${pct(result.monteCarlo.old[target][limit])}`);
  }
  console.log(`DKW 95%一様誤差上限: ±${pct(result.metadata.dkwUniformErrorBound)}`);
  console.log(`厳密値との最大差: 5.5周年=${pct(result.exactAudit.newMaxAbsoluteDifference)} 1.0周年=${pct(result.exactAudit.oldMaxAbsoluteDifference)}`);
}

if (require.main === module) main();
module.exports = { runSimulation, renderHtml, dkwErrorBound, exactNewCurves, exactOldCurves, oldCompletionPull, xoshiro128ss };
