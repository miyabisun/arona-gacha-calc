#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const NORMAL_RATE = 0.007;
const MAX_TARGETS = 4;
const MAX_PULLS = MAX_TARGETS * 200;
const TARGETS = [1, 2, 3, 4];
const OUTPUT_DIR = path.join(__dirname, '..', 'docs');

function rateForCharge(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 1;
  return NORMAL_RATE;
}

function emptyCurves() {
  return Object.fromEntries(TARGETS.map((target) => [target, Array(MAX_PULLS + 1).fill(0)]));
}

/** 5.5周年: (獲得人数, チャージ) に確率質量を集約する厳密DP。 */
function fivePointFiveCurves() {
  let states = new Map([['0:0', 1]]);
  let completedAll = 0;
  let maxMassError = 0;
  const curves = emptyCurves();

  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const next = new Map();
    for (const [key, mass] of states) {
      const [owned, charge] = key.split(':').map(Number);
      const rate = rateForCharge(charge);
      const successMass = mass * rate;
      const failureMass = mass * (1 - rate);
      const nextOwned = owned + 1;

      if (nextOwned === MAX_TARGETS) completedAll += successMass;
      else next.set(`${nextOwned}:0`, (next.get(`${nextOwned}:0`) ?? 0) + successMass);
      if (failureMass > 0) next.set(`${owned}:${charge + 1}`, (next.get(`${owned}:${charge + 1}`) ?? 0) + failureMass);
    }
    states = next;

    const byOwned = Array(MAX_TARGETS + 1).fill(0);
    byOwned[MAX_TARGETS] = completedAll;
    for (const [key, mass] of states) byOwned[Number(key.split(':', 1)[0])] += mass;
    const total = byOwned.reduce((sum, mass) => sum + mass, 0);
    maxMassError = Math.max(maxMassError, Math.abs(total - 1));
    for (const target of TARGETS) curves[target][pull] = byOwned.slice(target).reduce((sum, mass) => sum + mass, 0);
  }
  return { curves, maxMassError };
}

/** 1人を獲得するまでの所要回数分布（1〜200連）。 */
function singleCycleDistribution() {
  const exact = Array(201).fill(0);
  let survival = 1;
  for (let pull = 1; pull <= 200; pull += 1) {
    const rate = rateForCharge(pull - 1);
    exact[pull] = survival * rate;
    survival *= 1 - rate;
  }
  return exact;
}

/** 5.5周年の独立検算: 単一PU分布を人数分だけ畳み込む。 */
function convolutionCurves() {
  const single = singleCycleDistribution();
  const curves = emptyCurves();
  let completion = [1];
  for (const target of TARGETS) {
    const next = Array(target * 200 + 1).fill(0);
    for (let previous = 0; previous < completion.length; previous += 1) {
      for (let cycle = 1; cycle <= 200; cycle += 1) next[previous + cycle] += completion[previous] * single[cycle];
    }
    completion = next;
    let cumulative = 0;
    for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
      cumulative += completion[pull] ?? 0;
      curves[target][pull] = cumulative;
    }
  }
  return curves;
}

/** 1.0周年: 自引き済み人数を1連ずつ更新し、200ptごとの交換を加える。 */
function onePointZeroCurves() {
  const curves = emptyCurves();
  let natural = [1, 0, 0, 0, 0];
  let maxMassError = 0;
  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const next = Array(MAX_TARGETS + 1).fill(0);
    for (let owned = 0; owned <= MAX_TARGETS; owned += 1) {
      next[owned] += natural[owned] * (owned === MAX_TARGETS ? 1 : 1 - NORMAL_RATE);
      if (owned < MAX_TARGETS) next[owned + 1] += natural[owned] * NORMAL_RATE;
    }
    natural = next;
    maxMassError = Math.max(maxMassError, Math.abs(natural.reduce((sum, mass) => sum + mass, 0) - 1));
    const exchanges = Math.floor(pull / 200);
    for (const target of TARGETS) {
      curves[target][pull] = natural.reduce((sum, mass, owned) => sum + (owned + exchanges >= target ? mass : 0), 0);
    }
  }
  return { curves, maxMassError };
}

/** 二項分布による1.0周年の独立検算。必要な自引き人数は最大4なので安定して計算できる。 */
function binomialTail(trials, minimum) {
  if (minimum <= 0) return 1;
  if (minimum > trials) return 0;
  const q = 1 - NORMAL_RATE;
  let term = q ** trials;
  let below = term;
  for (let successes = 1; successes < minimum; successes += 1) {
    term *= ((trials - successes + 1) / successes) * (NORMAL_RATE / q);
    below += term;
  }
  return 1 - below;
}

function onePointZeroClosedFormCurves() {
  const curves = emptyCurves();
  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const exchanges = Math.floor(pull / 200);
    for (const target of TARGETS) curves[target][pull] = binomialTail(pull, target - exchanges);
  }
  return curves;
}

function maxDifference(left, right) {
  let maximum = 0;
  for (const target of TARGETS) {
    for (let pull = 0; pull <= MAX_PULLS; pull += 1) maximum = Math.max(maximum, Math.abs(left[target][pull] - right[target][pull]));
  }
  return maximum;
}

function curveInvariantError(curves) {
  let maximum = 0;
  for (const target of TARGETS) {
    for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
      maximum = Math.max(maximum, Math.max(0, curves[target][pull - 1] - curves[target][pull]));
      maximum = Math.max(maximum, Math.max(0, -curves[target][pull], curves[target][pull] - 1));
    }
    maximum = Math.max(maximum, Math.abs(curves[target][target * 200] - 1));
  }
  return maximum;
}

function calculateComparison() {
  const five = fivePointFiveCurves();
  const one = onePointZeroCurves();
  const fiveCrossCheck = convolutionCurves();
  const oneCrossCheck = onePointZeroClosedFormCurves();
  const result = {
    metadata: {
      method: 'exact dynamic programming; no Monte Carlo sampling',
      maxPulls: MAX_PULLS,
      maxTargets: MAX_TARGETS,
      normalPuRate: NORMAL_RATE,
      stateUpperBound: (MAX_TARGETS * 200) + 1,
    },
    assumptions: {
      fivePointFiveAnniversary: '通常0.7%、チャージ99で50%、199で100%。対象PU獲得時にチャージ0。',
      onePointZeroAnniversary: '通常0.7%。募集終了時に200ptごとに未所持PUを1人交換。',
      nonTargetPuSpooksCounted: false,
    },
    curves: {
      anniversary5_5: five.curves,
      anniversary1_0: one.curves,
    },
    audit: {
      anniversary5_5CrossCheck: 'single-cycle distribution convolved 1–4 times',
      anniversary1_0CrossCheck: 'binomial tail closed form',
      anniversary5_5MaxCrossCheckDifference: maxDifference(five.curves, fiveCrossCheck),
      anniversary1_0MaxCrossCheckDifference: maxDifference(one.curves, oneCrossCheck),
      maxMassError: Math.max(five.maxMassError, one.maxMassError),
      maxInvariantError: Math.max(curveInvariantError(five.curves), curveInvariantError(one.curves)),
    },
  };
  const tolerance = 1e-12;
  if (result.audit.anniversary5_5MaxCrossCheckDifference > tolerance
    || result.audit.anniversary1_0MaxCrossCheckDifference > tolerance
    || result.audit.maxMassError > tolerance
    || result.audit.maxInvariantError > tolerance) {
    throw new Error(`厳密計算の監査に失敗: ${JSON.stringify(result.audit)}`);
  }
  return result;
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
  return `<div class="chart-shell" data-chart="${id}" data-max="${maxPulls}" tabindex="0" aria-label="${target}人を揃える確率グラフ。左右矢印で1連、Page UpとPage Downで10連、HomeとEndで移動できます"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${target}人を揃える累積確率の1.0周年と5.5周年比較"><g class="grid">${yLines}${xLines}</g><path class="curve one" d="${chartPath(result.curves.anniversary1_0[target], maxPulls)}"/><path class="curve five" d="${chartPath(result.curves.anniversary5_5[target], maxPulls)}"/><rect class="hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/><circle class="hover-dot one" r="5"/><circle class="hover-dot five" r="5"/></svg><output class="chart-tip" aria-live="polite"></output></div>`;
}

function renderHtml(result) {
  const chartData = JSON.stringify(Object.fromEntries([
    ['one', 1], ['two', 2], ['three', 3], ['four', 4],
  ].map(([name, target]) => [name, {
    five: result.curves.anniversary5_5[target].slice(0, target * 200 + 1),
    one: result.curves.anniversary1_0[target].slice(0, target * 200 + 1),
  }]))).replaceAll('<', '\\u003c');
  const graph = (target, id) => {
    const maxPulls = target * 200;
    return `<section class="panel"><div class="panel-head"><div><div class="eyebrow">${target} target${target > 1 ? 's' : ''} / ${maxPulls} pulls</div><h2>${target}人を${maxPulls}連で揃える</h2></div><div class="legend" aria-label="グラフの凡例"><span><i class="five"></i>5.5周年（実線）</span><span><i class="one"></i>1.0周年（破線）</span><span class="safe-key"><i></i>75% 安全圏</span></div></div>${graphSvg(result,target,maxPulls,id)}</section>`;
  };
  const audit = result.audit;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PU募集 1.0周年・5.5周年比較</title><style>
:root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e;--series-five:#14506e;--series-one:#9a6a00;--safe:#8f3d35;--grid-minor:#e3d9c9;--grid-major:#a99c8e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible,button:focus-visible,.chart-shell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(1100px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}h1{font-size:17px;font-weight:600;line-height:1.3;margin:4px 0 12px}h2{font-size:17px;line-height:1.3}.eyebrow{color:var(--accent);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.lede{color:var(--muted);max-width:62rem}.hero{padding:16px 0 24px}.panel{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}.panel h2{margin:0}.panel-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:12px}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:24px;margin-right:4px;vertical-align:middle;border-top:3px solid}.legend .five{border-color:var(--series-five)}.legend .one{border-color:var(--series-one);border-top-style:dashed}.legend .safe-key i{border-color:var(--safe);border-top-width:2px}.chart-shell{position:relative;border-radius:6px;touch-action:pan-y}.chart-shell svg{display:block;width:100%;height:auto;overflow:visible}.grid line.horizontal{stroke:var(--grid-minor);stroke-width:1}.grid line.minor{stroke:var(--grid-minor);stroke-width:.6}.grid line.major{stroke:var(--grid-major);stroke-width:1}.grid line.safe{stroke:var(--safe);stroke-width:2}.grid text{fill:var(--muted);font:12px system-ui,sans-serif;text-anchor:middle}.grid text.safe{fill:var(--safe);font-weight:600;text-anchor:end}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}.curve.five{stroke:var(--series-five)}.curve.one{stroke:var(--series-one);stroke-dasharray:10 7}.hit{fill:transparent;cursor:crosshair}.hover-dot{display:none;pointer-events:none;stroke:var(--raised);stroke-width:2}.hover-dot.five{fill:var(--series-five)}.hover-dot.one{fill:var(--series-one)}.chart-tip{position:absolute;display:none;max-width:calc(100% - 8px);pointer-events:none;background:var(--raised);color:var(--on);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;line-height:1.4;white-space:normal;z-index:3}.small{font-size:14px;color:var(--muted)}.term{appearance:none;background:transparent;color:var(--link);font:inherit;border:0;border-bottom:1px dotted currentColor;padding:0;cursor:help;position:relative}.term:after{content:attr(data-tip);position:absolute;left:0;bottom:calc(100% + 8px);width:min(340px,calc(100vw - 48px));padding:8px;background:var(--raised);border:1px solid var(--border);border-radius:6px;color:var(--on);font-size:12px;line-height:1.5;opacity:0;visibility:hidden;z-index:5}.term:hover:after,.term:focus-visible:after{opacity:1;visibility:visible}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}@media(max-width:760px){main{width:min(100% - 16px,1100px);margin:16px auto}.panel{padding:12px 8px}.panel-head{display:block;padding:0 4px}.legend{margin-top:8px;gap:8px}.curve{stroke-width:6}.hero{padding-top:8px}.chart-tip{font-size:12px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff;--series-five:#7fdbff;--series-one:#e0a800;--safe:#ff8d84;--grid-minor:#333333;--grid-major:#666}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
</style></head><body><main><nav class="nav"><a href="./" aria-current="page">周年比較</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="eyebrow">Exact probability / 1.0 &amp; 5.5 anniversary</div><h1>お迎え率が100%へ<br>届くまで。</h1><p class="lede">1.0周年の呼び出しポイント方式と、5.5周年の呼び出しチャージ方式を、1連ごとの厳密な累積確率で比較します。赤線は75%の安全圏です。</p></header>
${graph(1,'one')}${graph(2,'two')}${graph(3,'three')}${graph(4,'four')}
<section class="panel small"><p><button class="term" data-tip="全履歴を列挙せず、獲得人数とチャージが同じ履歴を一つの状態へまとめ、成功・失敗の確率質量を1連ずつ遷移させます。">状態DPによる厳密計算</button>です。モンテカルロ法や乱数は使用していません。5.5周年は所要回数分布の畳み込み、1.0周年は二項分布の閉形式でも独立検算しました。</p><p>最大照合差：5.5周年 ${audit.anniversary5_5MaxCrossCheckDifference.toExponential(3)}／1.0周年 ${audit.anniversary1_0MaxCrossCheckDifference.toExponential(3)}。確率質量の最大誤差 ${audit.maxMassError.toExponential(3)}。前提と監査方法は<a href="faq.html">Q&amp;A</a>に記載しています。</p></section><footer>Generated by scripts/compare.js — exact dynamic programming</footer></main>
<script>const DATA=${chartData};document.querySelectorAll('[data-chart]').forEach(shell=>{const svg=shell.querySelector('svg'),hit=shell.querySelector('.hit'),tip=shell.querySelector('.chart-tip'),fiveDot=shell.querySelector('.hover-dot.five'),oneDot=shell.querySelector('.hover-dot.one'),series=DATA[shell.dataset.chart],max=Number(shell.dataset.max),left=58,right=18,top=18,bottom=42,width=920,height=430,plotWidth=width-left-right,plotHeight=height-top-bottom;let current=0;const show=pull=>{current=Math.max(0,Math.min(max,pull));const r=svg.getBoundingClientRect(),x=left+(current/max)*plotWidth,fiveY=top+(1-series.five[current])*plotHeight,oneY=top+(1-series.one[current])*plotHeight;for(const [dot,y] of [[fiveDot,fiveY],[oneDot,oneY]]){dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.style.display='block'}tip.style.display='block';tip.textContent=current+'連｜5.5周年 '+(series.five[current]*100).toFixed(6)+'%｜1.0周年 '+(series.one[current]*100).toFixed(6)+'%';const desired=(x/width)*r.width+8,tipWidth=tip.offsetWidth,tipHeight=tip.offsetHeight;tip.style.left=Math.max(4,Math.min(r.width-tipWidth-4,desired))+'px';tip.style.top=Math.max(4,Math.min(r.height-tipHeight-4,Math.min(fiveY,oneY)/height*r.height-tipHeight-8))+'px'};hit.addEventListener('pointermove',e=>{const r=svg.getBoundingClientRect(),svgX=(e.clientX-r.left)/r.width*width,ratio=Math.max(0,Math.min(1,(svgX-left)/plotWidth));show(Math.round(ratio*max))});hit.addEventListener('pointerleave',()=>{if(document.activeElement!==shell){tip.style.display='none';fiveDot.style.display='none';oneDot.style.display='none'}});shell.addEventListener('focus',()=>show(current));shell.addEventListener('blur',()=>{tip.style.display='none';fiveDot.style.display='none';oneDot.style.display='none'});shell.addEventListener('keydown',e=>{const moves={ArrowLeft:-1,ArrowRight:1,PageUp:10,PageDown:-10};let next=current;if(e.key in moves)next+=moves[e.key];else if(e.key==='Home')next=0;else if(e.key==='End')next=max;else return;e.preventDefault();show(next)})});</script></body></html>`;
}

function main() {
  const started = process.hrtime.bigint();
  const result = calculateComparison();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), renderHtml(result));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`厳密計算: ${elapsedMs.toFixed(2)}ms`);
  for (const target of TARGETS) {
    const limit = target * 200;
    console.log(`${target}人/${limit}連 5.5周年=${(result.curves.anniversary5_5[target][limit] * 100).toFixed(6)}% 1.0周年=${(result.curves.anniversary1_0[target][limit] * 100).toFixed(6)}%`);
  }
  console.log(`最大照合差: 5.5周年=${result.audit.anniversary5_5MaxCrossCheckDifference.toExponential(3)} 1.0周年=${result.audit.anniversary1_0MaxCrossCheckDifference.toExponential(3)}`);
}

if (require.main === module) main();
module.exports = { calculateComparison, rateForCharge, singleCycleDistribution, fivePointFiveCurves, convolutionCurves, onePointZeroCurves, onePointZeroClosedFormCurves, binomialTail, renderHtml };
