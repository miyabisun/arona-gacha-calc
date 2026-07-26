#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const NORMAL_RATE = 0.007;
const MAX_TARGETS = 10;
const MAX_PULLS = MAX_TARGETS * 200;
const TARGETS = Array.from({ length: MAX_TARGETS }, (_, index) => index + 1);
const OUTPUT_DIR = path.join(__dirname, '..', 'docs');
const IMAGE_DIR = path.join(OUTPUT_DIR, 'img');

function rateForCharge(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 1;
  return NORMAL_RATE;
}

function emptyCurves() {
  return Object.fromEntries(TARGETS.map((target) => [target, Array(MAX_PULLS + 1).fill(0)]));
}

/** 呼出チャージ: (獲得PU数, チャージ) に確率質量を集約する厳密DP。 */
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

/** 呼出チャージの独立検算: 単一PU分布を必要PU数分だけ畳み込む。 */
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

/** 呼出ポイント: 自引き済みPU数を1連ずつ更新し、200ptごとの交換を加える。 */
function onePointZeroCurves() {
  const curves = emptyCurves();
  let natural = Array(MAX_TARGETS + 1).fill(0);
  natural[0] = 1;
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

/** 二項分布による呼出ポイントの独立検算。 */
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
      anniversary5_5CrossCheck: 'single-cycle distribution convolved 1–10 times',
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

function graphGeometry(result, target) {
  const maxPulls = target * 200;
  const width = 920; const height = 430; const left = 58; const right = 18; const top = 18; const bottom = 42;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const yLines = [0, .25, .5, .75, 1].map((value) => {
    const y = top + (1 - value) * plotHeight;
    return `<line class="horizontal" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text x="${left - 10}" y="${y + 4}">${value * 100}%</text>`;
  }).join('');
  const xLines = Array.from({ length: Math.floor(maxPulls / 10) + 1 }, (_, index) => index * 10).map((pull) => {
    const x = left + (pull / maxPulls) * plotWidth;
    const major = pull % 100 === 0;
    return `<line class="${major ? 'major' : 'minor'}" x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}"/>${major ? `<text x="${x}" y="${height - 14}">${pull}</text>` : ''}`;
  }).join('');
  return `<g class="grid">${yLines}${xLines}</g><path class="curve point" d="${chartPath(result.curves.anniversary1_0[target], maxPulls)}"/><path class="curve charge" d="${chartPath(result.curves.anniversary5_5[target], maxPulls)}"/><rect class="hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/><circle class="hover-dot point" r="5"/><circle class="hover-dot charge" r="5"/>`;
}

function standaloneSvg(result, target) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 430" role="img" aria-labelledby="title desc"><title id="title">${target}PUのガチャ確率</title><desc id="desc">呼出チャージは実線、呼出ポイントは破線。0%から100%までの累積確率。</desc><style>:root{color-scheme:light dark}.grid line{stroke:#e3d9c9}.grid .minor{stroke-width:.6}.grid .major{stroke:#a99c8e}.grid text{fill:#6f6257;font:12px system-ui,sans-serif;text-anchor:middle}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round}.charge{stroke:#14506e}.point{stroke:#9a6a00;stroke-dasharray:10 7}.hit,.hover-dot{display:none}@media(prefers-color-scheme:dark){.grid line{stroke:#333}.grid .major{stroke:#666}.grid text{fill:#9a9a9a}.charge{stroke:#7fdbff}.point{stroke:#e0a800}}</style>${graphGeometry(result, target)}</svg>`;
}

function renderHtml(result) {
  const chartData = JSON.stringify(Object.fromEntries(TARGETS.map((target) => [target, {
    charge: result.curves.anniversary5_5[target].slice(0, target * 200 + 1),
    point: result.curves.anniversary1_0[target].slice(0, target * 200 + 1),
  }]))).replaceAll('<', '\\u003c');
  const tabs = TARGETS.map((target) => `<button type="button" role="tab" id="tab-${target}pu" aria-controls="chart-panel" aria-selected="${target === 2}" tabindex="${target === 2 ? 0 : -1}" data-target="${target}">${target}pu</button>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlueArchive ガチャ確率表</title><style>
:root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e;--series-charge:#14506e;--series-point:#9a6a00;--grid-minor:#e3d9c9;--grid-major:#a99c8e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible,button:focus-visible,.chart-shell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(1100px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}h1,h2{font-size:17px;font-weight:600;line-height:1.3}.hero{padding:16px 0 24px}.header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.hero h1{margin:0}.repo-link{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-decoration:none}.repo-link:hover{color:var(--link)}.repo-link svg{width:20px;height:20px;flex:none}.panel{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}.panel-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:12px}.panel h2{margin:0}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:24px;margin-right:4px;vertical-align:middle;border-top:3px solid}.legend .charge{border-color:var(--series-charge)}.legend .point{border-color:var(--series-point);border-top-style:dashed}.tabs{display:flex;gap:4px;overflow-x:auto;padding:4px 2px 8px;margin:0 0 12px;scrollbar-width:thin}.tabs button{flex:0 0 auto;min-width:52px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--muted);font:500 15px/1.2 system-ui,sans-serif;cursor:pointer}.tabs button[aria-selected="true"]{background:var(--accent-subtle);border-color:var(--accent);color:var(--on)}.chart-shell{position:relative;border-radius:6px;touch-action:pan-y}.chart-shell svg{display:block;width:100%;height:auto;overflow:visible}.grid line.horizontal{stroke:var(--grid-minor);stroke-width:1}.grid line.minor{stroke:var(--grid-minor);stroke-width:.6}.grid line.major{stroke:var(--grid-major);stroke-width:1}.grid text{fill:var(--muted);font:12px system-ui,sans-serif;text-anchor:middle}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}.curve.charge{stroke:var(--series-charge)}.curve.point{stroke:var(--series-point);stroke-dasharray:10 7}.hit{fill:transparent;cursor:crosshair}.hover-dot{display:none;pointer-events:none;stroke:var(--raised);stroke-width:2}.hover-dot.charge{fill:var(--series-charge)}.hover-dot.point{fill:var(--series-point)}.chart-tip{position:absolute;display:none;max-width:calc(100% - 16px);pointer-events:none;background:var(--raised);color:var(--on);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;line-height:1.5;text-align:left;white-space:pre-line;font-variant-numeric:tabular-nums;z-index:3}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}@media(max-width:760px){main{width:min(100% - 16px,1100px);margin:16px auto}.panel{padding:12px 8px}.panel-head{display:block;padding:0 4px}.legend{margin-top:8px;gap:8px}.curve{stroke-width:6}.hero{padding-top:8px}.repo-link span{display:none}.chart-tip{font-size:12px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff;--series-charge:#7fdbff;--series-point:#e0a800;--grid-minor:#333;--grid-major:#666}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
</style></head><body><main><nav class="nav"><a href="./" aria-current="page">確率表</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>BlueArchive ガチャ確率表</h1><a class="repo-link" href="https://github.com/miyabisun/arona-gacha-calc" aria-label="GitHubリポジトリを開く"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.5 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/></svg><span>miyabisun/arona-gacha-calc</span></a></div></header><div class="tabs" role="tablist" aria-label="必要なPU数">${tabs}</div><section class="panel" id="chart-panel" role="tabpanel" aria-labelledby="tab-2pu"><div class="panel-head"><h2 id="chart-title">2PUを400連で揃える</h2><div class="legend" aria-label="グラフの凡例"><span><i class="charge"></i>呼出チャージ（実線）</span><span><i class="point"></i>呼出ポイント（破線）</span></div></div><div id="chart-host"></div></section><footer>Generated by scripts/compare.js</footer></main>
<script>const DATA=${chartData},TARGET_MIN=1,TARGET_MAX=10,W=920,H=430,L=58,R=18,T=18,B=42,PW=W-L-R,PH=H-T-B;const host=document.getElementById('chart-host'),panel=document.getElementById('chart-panel'),title=document.getElementById('chart-title'),tabs=[...document.querySelectorAll('[role="tab"]')];let selected=2;function path(values,max){return values.map((value,pull)=>(pull?'L':'M')+(L+pull/max*PW).toFixed(2)+','+(T+(1-value)*PH).toFixed(2)).join(' ')}function svgMarkup(target){const max=target*200,series=DATA[target],ys=[0,.25,.5,.75,1].map(value=>{const y=T+(1-value)*PH;return '<line class="horizontal" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'"/><text x="'+(L-10)+'" y="'+(y+4)+'">'+(value*100)+'%</text>'}).join(''),xs=Array.from({length:Math.floor(max/10)+1},(_,i)=>i*10).map(pull=>{const x=L+pull/max*PW,major=pull%100===0;return '<line class="'+(major?'major':'minor')+'" x1="'+x+'" y1="'+T+'" x2="'+x+'" y2="'+(H-B)+'"/>'+(major?'<text x="'+x+'" y="'+(H-14)+'">'+pull+'</text>':'')}).join('');return '<div class="chart-shell" data-max="'+max+'" tabindex="0" aria-label="'+target+'PUの確率グラフ。左右矢印で1連、Page UpとPage Downで10連、HomeとEndで移動できます"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+target+'PUを揃える呼出ポイントと呼出チャージの累積確率"><g class="grid">'+ys+xs+'</g><path class="curve point" d="'+path(series.point,max)+'"/><path class="curve charge" d="'+path(series.charge,max)+'"/><rect class="hit" x="'+L+'" y="'+T+'" width="'+PW+'" height="'+PH+'"/><circle class="hover-dot point" r="5"/><circle class="hover-dot charge" r="5"/></svg><output class="chart-tip" aria-live="polite"></output></div>'}function wire(target){const shell=host.querySelector('.chart-shell'),svg=shell.querySelector('svg'),hit=shell.querySelector('.hit'),tip=shell.querySelector('.chart-tip'),chargeDot=shell.querySelector('.hover-dot.charge'),pointDot=shell.querySelector('.hover-dot.point'),series=DATA[target],max=target*200;let current=0;const show=pull=>{current=Math.max(0,Math.min(max,pull));const x=L+current/max*PW,chargeY=T+(1-series.charge[current])*PH,pointY=T+(1-series.point[current])*PH;for(const [dot,y] of [[chargeDot,chargeY],[pointDot,pointY]]){dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.style.display='block'}tip.style.display='block';tip.textContent=current+'連\\n呼出チャージ '+(series.charge[current]*100).toFixed(2)+'%\\n呼出ポイント '+(series.point[current]*100).toFixed(2)+'%';const rect=svg.getBoundingClientRect(),pointLeft=x/W*rect.width,pointTop=pointY/H*rect.height,tipWidth=tip.offsetWidth;tip.style.left=Math.max(4,Math.min(rect.width-tipWidth-4,pointLeft+8))+'px';tip.style.top=(pointTop+8)+'px'};hit.addEventListener('pointermove',event=>{const rect=svg.getBoundingClientRect(),svgX=(event.clientX-rect.left)/rect.width*W,ratio=Math.max(0,Math.min(1,(svgX-L)/PW));show(Math.round(ratio*max))});hit.addEventListener('pointerleave',()=>{if(document.activeElement!==shell){tip.style.display='none';chargeDot.style.display='none';pointDot.style.display='none'}});shell.addEventListener('focus',()=>show(current));shell.addEventListener('blur',()=>{tip.style.display='none';chargeDot.style.display='none';pointDot.style.display='none'});shell.addEventListener('keydown',event=>{const moves={ArrowLeft:-1,ArrowRight:1,PageUp:10,PageDown:-10};let next=current;if(event.key in moves)next+=moves[event.key];else if(event.key==='Home')next=0;else if(event.key==='End')next=max;else return;event.preventDefault();show(next)})}function select(target,updateUrl){selected=Math.max(TARGET_MIN,Math.min(TARGET_MAX,target));tabs.forEach(tab=>{const active=Number(tab.dataset.target)===selected;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1});title.textContent=selected+'PUを'+(selected*200)+'連で揃える';panel.setAttribute('aria-labelledby','tab-'+selected+'pu');host.innerHTML=svgMarkup(selected);wire(selected);if(updateUrl)history.pushState({target:selected},'',location.pathname+location.search+'#'+selected+'pu')}tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>select(Number(tab.dataset.target),true));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;if(event.key==='ArrowRight')next=(index+1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;tabs[next].focus();select(Number(tabs[next].dataset.target),true)})});addEventListener('popstate',()=>{const match=location.hash.match(/^#([1-9]|10)pu$/);select(match?Number(match[1]):2,false)});const initial=location.hash.match(/^#([1-9]|10)pu$/);select(initial?Number(initial[1]):2,false);</script></body></html>`;
}

function main() {
  const started = process.hrtime.bigint();
  const result = calculateComparison();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), renderHtml(result));
  for (let target = 1; target <= 4; target += 1) {
    fs.writeFileSync(path.join(IMAGE_DIR, `${target}pu.svg`), standaloneSvg(result, target));
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`厳密計算: ${elapsedMs.toFixed(2)}ms`);
  for (const target of TARGETS) {
    const limit = target * 200;
    console.log(`${target}PU/${limit}連 呼出チャージ=${(result.curves.anniversary5_5[target][limit] * 100).toFixed(2)}% 呼出ポイント=${(result.curves.anniversary1_0[target][limit] * 100).toFixed(2)}%`);
  }
  console.log(`最大照合差: 呼出チャージ=${result.audit.anniversary5_5MaxCrossCheckDifference.toExponential(3)} 呼出ポイント=${result.audit.anniversary1_0MaxCrossCheckDifference.toExponential(3)}`);
}

if (require.main === module) main();
module.exports = { calculateComparison, rateForCharge, singleCycleDistribution, fivePointFiveCurves, convolutionCurves, onePointZeroCurves, onePointZeroClosedFormCurves, binomialTail, renderHtml, standaloneSvg };
