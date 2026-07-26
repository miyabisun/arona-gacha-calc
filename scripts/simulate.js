#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const NORMAL_RATE = 0.007;
const MAX_PULLS = 400;
const DEFAULT_TRIALS = 1_000_000;
const SEED = [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344];
const TARGETS = [2, 3, 4];
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
  for (let exchanges = 0; exchanges <= 2; exchanges += 1) {
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
      newRule: '対象PUを順に狙う。通常0.7%、チャージ99で50%、199で100%。獲得時チャージ0。',
      oldRule: '対象PUを順に通常0.7%で狙い、各制限回数の終了後にfloor(募集回数/200)人まで未所持PUを交換。',
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
    return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text x="${left - 10}" y="${y + 4}">${value * 100}%</text>`;
  }).join('');
  const xLines = Array.from({ length: Math.floor(maxPulls / 50) + 1 }, (_, index) => index * 50).map((pull) => {
    const x = left + (pull / maxPulls) * plotWidth;
    return `<line x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}"/><text x="${x}" y="${height - 14}">${pull}</text>`;
  }).join('');
  return `<div class="chart-shell" data-chart="${id}" data-max="${maxPulls}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${target}人を揃える累積確率の新旧比較"><g class="grid">${yLines}${xLines}</g><path class="curve old" d="${chartPath(result.monteCarlo.old[target], maxPulls)}"/><path class="curve fresh" d="${chartPath(result.monteCarlo.new[target], maxPulls)}"/><line class="cursor" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"/><rect class="hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></svg><output class="chart-tip"></output></div>`;
}

function tableRows(result, target, pulls) {
  return pulls.map((pull) => {
    const fresh = result.monteCarlo.new[target][pull];
    const old = result.monteCarlo.old[target][pull];
    return `<tr><th>${pull}連</th><td>${pct(fresh)}</td><td>${pct(old)}</td><td class="${fresh >= old ? 'plus' : 'minus'}">${fresh >= old ? '+' : ''}${pct(fresh - old)}</td></tr>`;
  }).join('');
}

function renderHtml(result) {
  const chartData = JSON.stringify({
    two: { new: result.monteCarlo.new[2].slice(0, 301), old: result.monteCarlo.old[2].slice(0, 301) },
    three: { new: result.monteCarlo.new[3], old: result.monteCarlo.old[3] },
    four: { new: result.monteCarlo.new[4], old: result.monteCarlo.old[4] },
  }).replaceAll('<', '\\u003c');
  const bound = points(result.metadata.dkwUniformErrorBound, 3);
  const oneWithin100 = 1 - (0.993 ** 99) * 0.5;
  const eitherWithin100 = 1 - ((1 - oneWithin100) ** 2);
  const remainingRoutes = result.exactAudit.new[2][300] - eitherWithin100;
  const trialMultiplier = result.metadata.trials / 10_000;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PU募集 新旧仕様シミュレーション</title><style>
:root{--night:#07111f;--panel:#0d1d2d;--line:#25445b;--text:#e9f5ff;--muted:#8eabc0;--new:#49d5ff;--old:#ffcc67;--good:#62e3a4;--bad:#ff7d8f}*{box-sizing:border-box}body{margin:0;background:var(--night);color:var(--text);font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;line-height:1.7;background-image:radial-gradient(circle at 80% 5%,#174b6655,transparent 33%),linear-gradient(#17314822 1px,transparent 1px),linear-gradient(90deg,#17314822 1px,transparent 1px);background-size:auto,24px 24px,24px 24px}main{width:min(1180px,calc(100% - 30px));margin:44px auto 70px}.eyebrow{font:700 .75rem ui-monospace,monospace;color:var(--new);letter-spacing:.17em;text-transform:uppercase}h1{font-family:"Yu Mincho","Hiragino Mincho ProN",serif;font-size:clamp(2rem,6vw,4.6rem);line-height:1.04;letter-spacing:.02em;margin:.15em 0}.lede{color:var(--muted);max-width:62rem;font-size:1.04rem}.hero{padding:38px 0 30px}.verdict{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin-top:30px}.metric{background:#091827;padding:20px}.metric small{display:block;color:var(--muted)}.metric strong{display:block;font:700 clamp(1.55rem,4vw,2.6rem) ui-monospace,monospace;letter-spacing:-.05em}.panel{background:#0b1927ed;border:1px solid var(--line);padding:26px;margin:22px 0;box-shadow:10px 10px 0 #020b13}.panel h2{font:700 clamp(1.25rem,3vw,1.8rem) "Yu Mincho",serif;margin:0 0 6px}.panel-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.legend{display:flex;gap:16px;color:var(--muted);font-size:.85rem}.legend i{display:inline-block;width:22px;height:3px;margin-right:7px;vertical-align:middle}.legend .n{background:var(--new)}.legend .o{background:var(--old)}.chart-shell{position:relative}.chart-shell svg{display:block;width:100%;height:auto}.grid line{stroke:#244258;stroke-width:1}.grid text{fill:var(--muted);font:12px ui-monospace,monospace;text-anchor:middle}.grid text:first-of-type{text-anchor:end}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round}.curve.fresh{stroke:var(--new)}.curve.old{stroke:var(--old)}.cursor{stroke:#fff;stroke-width:1;stroke-dasharray:4 5;opacity:0;pointer-events:none}.hit{fill:transparent;cursor:crosshair}.chart-tip{position:absolute;display:none;pointer-events:none;background:#020a12ee;border:1px solid #5f8299;padding:8px 11px;font:12px/1.5 ui-monospace,monospace;white-space:nowrap}.tables{display:grid;grid-template-columns:1fr 1fr;gap:20px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font:14px ui-monospace,"Yu Gothic",monospace;font-variant-numeric:tabular-nums}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child{text-align:left}thead th{color:var(--muted);font-size:.78rem}.plus{color:var(--good)}.minus{color:var(--bad)}.small{font-size:.82rem;color:var(--muted)}.term{all:unset;border-bottom:1px dotted var(--new);cursor:help;position:relative}.term:after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);width:min(320px,80vw);padding:10px;background:#020a12;border:1px solid #5f8299;color:var(--text);font:12px/1.55 sans-serif;opacity:0;visibility:hidden;z-index:5}.term:hover:after,.term:focus:after{opacity:1;visibility:visible}.sources a{color:var(--new)}footer{color:var(--muted);font:12px ui-monospace,monospace;text-align:center;margin-top:34px}@media(max-width:760px){.verdict,.tables{grid-template-columns:1fr}.panel{padding:18px}.panel-head{display:block}.legend{margin-top:8px}.curve{stroke-width:6}.hero{padding-top:15px}}@media(prefers-reduced-motion:no-preference){.hero,.panel{animation:up .5s both}.panel:nth-of-type(2){animation-delay:.08s}.panel:nth-of-type(3){animation-delay:.14s}@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}}
</style></head><body><main><header class="hero"><div class="eyebrow"><a href="./" style="color:inherit">← Exact report</a> / Recruitment probability / simulation report</div><h1>余った1連が、<br>確率を押し上げる。</h1><p class="lede">PUを早く引いたぶん、次のPUへ残り回数をすべて渡す。固定された「100連を人数分」では見えなかった経路を、1連刻みで新旧比較しました。</p><div class="verdict"><div class="metric"><small>2人・新仕様 300連</small><strong>${pct(result.monteCarlo.new[2][300])}</strong></div><div class="metric"><small>2人・旧仕様 300連</small><strong>${pct(result.monteCarlo.old[2][300])}</strong></div><div class="metric"><small>新仕様の差</small><strong class="plus">+${pct(result.monteCarlo.new[2][300]-result.monteCarlo.old[2][300])}</strong></div></div></header>
<section class="panel"><div class="eyebrow">Why nearly 95%</div><h2>300連で高確率になる理由</h2><p>1人あたり最大200連なので、片方を100連以内に獲得できれば、もう片方には200連以上が残り確定します。「2回のうち少なくとも一方が100連以内」の経路だけで <strong class="plus">${pct(eitherWithin100)}</strong>。さらに、両方100連超でも合計300連以内となる経路が <strong class="plus">${pct(remainingRoutes)}</strong> あり、合計が約94.75%になります。</p></section>
<section class="panel"><div class="panel-head"><div><div class="eyebrow">Two targets / 1–300 pulls</div><h2>2人を揃える累積確率</h2></div><div class="legend"><span><i class="n"></i>新仕様</span><span><i class="o"></i>旧仕様＋交換</span></div></div>${graphSvg(result,2,300,'two')}<div class="table-wrap"><table><thead><tr><th>制限</th><th>新仕様</th><th>旧仕様</th><th>新−旧</th></tr></thead><tbody>${tableRows(result,2,[50,100,150,199,200,250,299,300])}</tbody></table></div></section>
<div class="tables"><section class="panel"><div class="panel-head"><div><div class="eyebrow">Anniversary / three targets</div><h2>3人を400連で狙う</h2></div><div class="legend"><span><i class="n"></i>新</span><span><i class="o"></i>旧</span></div></div>${graphSvg(result,3,400,'three')}<div class="table-wrap"><table><thead><tr><th>制限</th><th>新仕様</th><th>旧仕様</th><th>新−旧</th></tr></thead><tbody>${tableRows(result,3,[100,200,300,400])}</tbody></table></div></section><section class="panel"><div class="panel-head"><div><div class="eyebrow">Anniversary / four targets</div><h2>4人を400連で狙う</h2></div><div class="legend"><span><i class="n"></i>新</span><span><i class="o"></i>旧</span></div></div>${graphSvg(result,4,400,'four')}<div class="table-wrap"><table><thead><tr><th>制限</th><th>新仕様</th><th>旧仕様</th><th>新−旧</th></tr></thead><tbody>${tableRows(result,4,[100,200,300,400])}</tbody></table></div></section></div>
<section class="panel small sources"><p><button class="term" data-tip="各試行で募集を1回ずつ進め、成功した試行の割合を累積確率として推定します。固定シードなので再実行しても同じ結果です。">モンテカルロ法</button>を使用（${result.metadata.trials.toLocaleString('ja-JP')}試行）。各曲線の1〜400連全体に対する95%一様誤差幅は <strong>±${bound}</strong>。1万試行なら±${points(result.metadata.tenThousandTrialDkwBound,3)}となるため、今回は${trialMultiplier.toLocaleString('ja-JP')}倍にしました。厳密DPとの実測最大差は、新仕様 ${points(result.exactAudit.newMaxAbsoluteDifference,3)}／旧仕様 ${points(result.exactAudit.oldMaxAbsoluteDifference,3)}です。</p><p>前提：未所持PUを順に狙い、対象外PUのすり抜けは数えません。旧仕様は各時点で募集を終了した後、200ptごとに未所持1人を交換します。<button class="term" data-tip="経験分布関数と真の累積分布関数の最大差を、全ての募集回数について同時に抑える不等式です。">誤差幅の根拠</button>：<a href="https://doi.org/10.1214/aop/1176990746">Massart (1990)</a>、割合推定の参考：<a href="https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/propconf.htm">NIST</a>。</p></section><footer>Generated by simulate.js / seed ${result.metadata.seed.join(' · ')}</footer></main>
<script>const DATA=${chartData};document.querySelectorAll('[data-chart]').forEach(shell=>{const svg=shell.querySelector('svg'),hit=shell.querySelector('.hit'),cursor=shell.querySelector('.cursor'),tip=shell.querySelector('.chart-tip'),series=DATA[shell.dataset.chart],max=Number(shell.dataset.max);const move=e=>{const r=svg.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),pull=Math.round(ratio*max),x=58+(pull/max)*(920-58-18);cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);cursor.style.opacity=1;tip.style.display='block';tip.style.left=Math.min(r.width-150,Math.max(0,(x/920)*r.width+8))+'px';tip.style.top=Math.max(0,(e.clientY-r.top)-48)+'px';tip.textContent=pull+'連  新 '+(series.new[pull]*100).toFixed(3)+'% / 旧 '+(series.old[pull]*100).toFixed(3)+'%'};hit.addEventListener('pointermove',move);hit.addEventListener('pointerleave',()=>{cursor.style.opacity=0;tip.style.display='none'})});</script></body></html>`;
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
  for (const target of TARGETS) console.log(`${target}人/400連 新=${pct(result.monteCarlo.new[target][400])} 旧=${pct(result.monteCarlo.old[target][400])}`);
  console.log(`DKW 95%一様誤差上限: ±${pct(result.metadata.dkwUniformErrorBound)}`);
  console.log(`厳密値との最大差: 新=${pct(result.exactAudit.newMaxAbsoluteDifference)} 旧=${pct(result.exactAudit.oldMaxAbsoluteDifference)}`);
}

if (require.main === module) main();
module.exports = { runSimulation, renderHtml, dkwErrorBound, exactNewCurves, exactOldCurves, oldCompletionPull, xoshiro128ss };
