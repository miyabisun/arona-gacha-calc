#!/usr/bin/env node

/**
 * 5.5周年フェス限定募集の厳密確率計算。
 *
 * 通常の比較(compare.js)と違い、フェス限では星3排出率が6%へ倍化し、
 * 指名PU以外の新旧フェス限生徒も0.9%枠から出現する。この「すり抜け」で
 * 狙っている別の生徒を確保できるため、募集を1人へ集中させる戦略が成立する。
 *
 * 状態は (初回PUボーナス取得数, すり抜けのみで確保した数, 呼出チャージ)。
 * 生徒は同質として扱うので、誰を確保したかではなく人数だけを持てば足りる。
 */

const fs = require('node:fs');
const path = require('node:path');
const { localizeShell, replaceExact } = require('./localize.js');

const NORMAL_PU_RATE = 0.007;
const FES_STAR3_RATE = 0.06;
const LIMITED_STAR3_RATE = 0.03;
const BANK_PULLS = 99;
// 文字(エレフ)の入手。PU枠は重複でも100、すり抜け枠の重複は30。
const BONUS_LETTERS = 100;
const PU_DUPLICATE_LETTERS = 100;
const SPOOK_DUPLICATE_LETTERS = 30;
const DUPLICATE_SHARDS = 50;
// 凸コスト(累積)。星3を出発点として、星4→固有1→固有2→固有3→固有4。
const MILESTONE_LETTERS = [
  { name: '星4', cost: 100 },
  { name: '固有1', cost: 220 },
  { name: '固有2', cost: 340 },
  { name: '固有3', cost: 520 },
  { name: '固有4', cost: 720 },
];
// ショップの欠片交換レート。最初の20文字は1:1、以降20文字ごとに1段階ずつ重くなる。
const SHARD_TIERS = [{ letters: 20, rate: 1 }, { letters: 20, rate: 2 }, { letters: 20, rate: 3 }, { letters: 20, rate: 4 }];
const SHARD_TAIL_RATE = 5;
const SPOOK_TOTAL_RATE = 0.009;
const SPOOK_POOL = 9;
const SPOOK_EACH_RATE = SPOOK_TOTAL_RATE / SPOOK_POOL;
const EXCHANGE_INTERVAL = 200;
const BANKED_CHARGE = 99;
const MAX_PULLS = 800;
const TARGETS = [2, 3, 4];
const MILESTONES = [100, 200, 300, 400, 500, 600, 800];
const OUTPUT_DIR = path.join(__dirname, '..', 'docs');

/** 呼出チャージによる指名PUの確定枠。 */
function chargeHitRate(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 1;
  return NORMAL_PU_RATE;
}

/** 確定枠を外したあとに通常抽選が回る割合。199は確定なので通常抽選はない。 */
function chargeResidual(charge) {
  if (charge === 99) return 0.5;
  if (charge === 199) return 0;
  return 1;
}

function stateKey(bonus, spare, charge) {
  return `${bonus}:${spare}:${charge}`;
}

/**
 * 交換は未ボーナスの生徒へ1人分。素体を持っていない生徒を優先し、
 * 全員が素体済みなら素体持ちを指名してボーナスだけ回収する。
 */
function applyExchange(states, target) {
  const next = new Map();
  let letters = 0;
  let shards = 0;
  for (const [key, mass] of states) {
    const [bonus, spare, charge] = key.split(':').map(Number);
    const baseless = target - bonus - spare;
    if (baseless > 0) {
      // 未所持を引き取る。素体が増え、初回PUボーナスが付く。
      letters += mass * BONUS_LETTERS;
      const nextKey = stateKey(bonus + 1, spare, charge);
      next.set(nextKey, (next.get(nextKey) ?? 0) + mass);
    } else if (spare > 0) {
      // すり抜けで素体だけ持っていた生徒。重複分と未消費のボーナスがまとめて入る。
      letters += mass * (PU_DUPLICATE_LETTERS + BONUS_LETTERS);
      shards += mass * DUPLICATE_SHARDS;
      const nextKey = stateKey(bonus + 1, spare - 1, charge);
      next.set(nextKey, (next.get(nextKey) ?? 0) + mass);
    } else {
      // 全員回収済み。既所持を引き取って重複に変える。
      letters += mass * PU_DUPLICATE_LETTERS;
      shards += mass * DUPLICATE_SHARDS;
      next.set(key, (next.get(key) ?? 0) + mass);
    }
  }
  return { states: next, letters, shards };
}

function emptyCurves() {
  return {
    allBase: Array(MAX_PULLS + 1).fill(0),
    allBonus: Array(MAX_PULLS + 1).fill(0),
    expectedBase: Array(MAX_PULLS + 1).fill(0),
    expectedBonus: Array(MAX_PULLS + 1).fill(0),
    letters: Array(MAX_PULLS + 1).fill(0),
    shards: Array(MAX_PULLS + 1).fill(0),
  };
}

/**
 * 1連ずつ全分岐させる厳密DP。
 * useCharge=false は呼出ポイント(チャージ無し)、useExchange=true は200連ごとの交換。
 */
function runFestivalDp(target, { useCharge, useExchange, initialCharge = 0 }) {
  let states = new Map([[stateKey(0, 0, useCharge ? initialCharge : 0), 1]]);
  const curves = emptyCurves();
  let maxMassError = 0;
  let letters = 0;
  let shards = 0;

  for (let pull = 1; pull <= MAX_PULLS; pull += 1) {
    const next = new Map();
    const add = (key, mass) => next.set(key, (next.get(key) ?? 0) + mass);

    for (const [key, mass] of states) {
      const [bonus, spare, charge] = key.split(':').map(Number);
      const hit = useCharge ? chargeHitRate(charge) : NORMAL_PU_RATE;
      const residual = useCharge ? chargeResidual(charge) : 1;
      // 素体を持たない生徒のうち、指名中の1人はすり抜けプールに含まれない。
      const baseless = target - bonus - spare;
      const spook = residual * Math.max(0, baseless - 1) * SPOOK_EACH_RATE;
      // 指名中の1人を除いた「すでに素体を持つ対象生徒」が重なると重複報酬になる。
      const ownedInPool = Math.max(0, (bonus + spare) - (baseless > 0 ? 0 : 1));
      const spookDuplicate = residual * ownedInPool * SPOOK_EACH_RATE;
      const miss = 1 - hit - spook - spookDuplicate;
      const nextCharge = useCharge ? charge + 1 : 0;

      if (spookDuplicate > 0) {
        letters += mass * spookDuplicate * SPOOK_DUPLICATE_LETTERS;
        shards += mass * spookDuplicate * DUPLICATE_SHARDS;
        add(stateKey(bonus, spare, nextCharge), mass * spookDuplicate);
      }

      if (hit > 0) {
        const gained = mass * hit;
        if (baseless > 0) {
          // 未所持を指名。素体と初回PUボーナスを得る。
          letters += gained * BONUS_LETTERS;
          add(stateKey(bonus + 1, spare, 0), gained);
        } else if (spare > 0) {
          // すり抜けで素体だけ持っていた生徒。重複分と未消費のボーナスが同時に入る。
          letters += gained * (PU_DUPLICATE_LETTERS + BONUS_LETTERS);
          shards += gained * DUPLICATE_SHARDS;
          add(stateKey(bonus + 1, spare - 1, 0), gained);
        } else {
          // 全員分のボーナスを回収済み。以後は重複を積むだけ。
          letters += gained * PU_DUPLICATE_LETTERS;
          shards += gained * DUPLICATE_SHARDS;
          add(stateKey(bonus, spare, 0), gained);
        }
      }
      if (spook > 0) add(stateKey(bonus, spare + 1, nextCharge), mass * spook);
      if (miss > 0) add(stateKey(bonus, spare, nextCharge), mass * miss);
    }

    if (useExchange && pull % EXCHANGE_INTERVAL === 0) {
      const exchanged = applyExchange(next, target);
      states = exchanged.states;
      letters += exchanged.letters;
      shards += exchanged.shards;
    } else {
      states = next;
    }

    let total = 0;
    for (const [key, mass] of states) {
      const [bonus, spare] = key.split(':').map(Number);
      total += mass;
      // 目標人数に達した質量は以後も残り続けるので、到達率は最大値で積み上げる。
      if (bonus + spare >= target) curves.allBase[pull] += mass;
      if (bonus >= target) curves.allBonus[pull] += mass;
      curves.expectedBase[pull] += mass * Math.min(bonus + spare, target);
      curves.expectedBonus[pull] += mass * Math.min(bonus, target);
    }
    curves.allBase[pull] = Math.max(curves.allBase[pull], curves.allBase[pull - 1]);
    curves.allBonus[pull] = Math.max(curves.allBonus[pull], curves.allBonus[pull - 1]);
    curves.letters[pull] = letters;
    curves.shards[pull] = shards;
    maxMassError = Math.max(maxMassError, Math.abs(total - 1));
  }

  return { curves, maxMassError };
}

/** 欠片を文字へ換算する。安い段から順に使い、余りは切り捨てる。 */
function shardsToLetters(shards) {
  let remaining = shards;
  let gained = 0;
  for (const tier of SHARD_TIERS) {
    const affordable = Math.min(tier.letters, Math.floor(remaining / tier.rate));
    gained += affordable;
    remaining -= affordable * tier.rate;
    if (affordable < tier.letters) return gained;
  }
  return gained + Math.floor(remaining / SHARD_TAIL_RATE);
}

/** 累積確率が p を超える最小の連数。運用上の「どこまで払う覚悟が要るか」を示す。 */
function percentilePull(curve, p) {
  for (let pull = 0; pull < curve.length; pull += 1) if (curve[pull] >= p) return pull;
  return curve.length - 1;
}

/** 累積分布から期待所要連数を求める。上限までに終わらない質量は上限で打ち切る。 */
function expectedPulls(cumulative) {
  let expected = 0;
  for (let pull = 0; pull < MAX_PULLS; pull += 1) expected += 1 - cumulative[pull];
  return expected;
}

const SCENARIOS = [
  { id: 'charge', useCharge: true, useExchange: false },
  { id: 'point', useCharge: false, useExchange: true },
  { id: 'chargeBanked', useCharge: true, useExchange: false, initialCharge: BANKED_CHARGE },
];

function calculateFestival() {
  const scenarios = {};
  let maxMassError = 0;

  for (const scenario of SCENARIOS) {
    const byTarget = {};
    for (const target of TARGETS) {
      const { curves, maxMassError: massError } = runFestivalDp(target, scenario);
      maxMassError = Math.max(maxMassError, massError);
      byTarget[target] = {
        ...curves,
        expectedPullsToAllBase: expectedPulls(curves.allBase),
        expectedPullsToAllBonus: expectedPulls(curves.allBonus),
        // 新仕様は全員そろうまで降りられないので、上振れの重さを分位点で示す。
        pullsAtPercentile: Object.fromEntries([0.5, 0.75, 0.9, 0.95]
          .map((p) => [p, percentilePull(curves.allBase, p)])),
      };
    }
    scenarios[scenario.id] = byTarget;
  }

  // チャージ99を次の募集へ持ち越したときの効果。1人目にしか効かないので1名分で測る。
  const plainSingle = runFestivalDp(1, { useCharge: true, useExchange: false });
  const bankedSingle = runFestivalDp(1, { useCharge: true, useExchange: false, initialCharge: BANK_PULLS });
  const banking = {
    bankPulls: BANK_PULLS,
    expectedPullsPlain: expectedPulls(plainSingle.curves.allBonus),
    expectedPullsBanked: expectedPulls(bankedSingle.curves.allBonus),
    guaranteedWithinPlain: 200,
    // チャージ99で始めるとk連目のチャージは98+k。199の確定枠へ届くのは101連目。
    guaranteedWithinBanked: 200 - BANK_PULLS,
    survivalToBank: (1 - NORMAL_PU_RATE) ** BANK_PULLS,
    festivalStar3PerBank: FES_STAR3_RATE * BANK_PULLS,
    limitedStar3PerBank: LIMITED_STAR3_RATE * BANK_PULLS,
  };
  banking.savedPulls = banking.expectedPullsPlain - banking.expectedPullsBanked;

  const result = {
    metadata: {
      method: 'exact dynamic programming; no Monte Carlo sampling',
      maxPulls: MAX_PULLS,
      exchangeInterval: EXCHANGE_INTERVAL,
      bankedCharge: BANKED_CHARGE,
      targets: TARGETS,
      milestones: MILESTONES,
    },
    rates: {
      festivalStar3: FES_STAR3_RATE,
      limitedStar3: LIMITED_STAR3_RATE,
      namedPu: NORMAL_PU_RATE,
      spookPoolTotal: SPOOK_TOTAL_RATE,
      spookPoolSize: SPOOK_POOL,
      spookEach: SPOOK_EACH_RATE,
      otherStar3: FES_STAR3_RATE - NORMAL_PU_RATE - SPOOK_TOTAL_RATE,
    },
    assumptions: {
      namedPu: '指名した1名の排出率は0.7%。呼出チャージではチャージ99で50%、199で100%。',
      spook: '新旧フェス限10名から指名中の1名を除いた9名が0.9%を等分し、1名あたり0.1%。',
      spookOnCharge: 'チャージ99の確定50%を外した残り50%でのみ通常抽選が回り、199は確定のためすり抜けなし。',
      bonus: '初回PUボーナスは指名PUの自引きと呼出ポイント交換でのみ得られる。すり抜け獲得では得られない。',
      policy: '素体を持たない生徒を優先して指名し、全員が素体済みなら素体持ちを指名してボーナスだけ回収する。',
      exchange: '呼出ポイントは200連ごとに未ボーナスの生徒を1名交換する。',
      otherStar3Unused: '恒常星3の4.4%は内訳として記録するだけで計算には使わない。',
    },
    scenarios,
    banking,
    audit: { maxMassError },
  };

  if (maxMassError > 1e-12) throw new Error(`確率質量の保存に失敗: ${maxMassError}`);
  return result;
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** 曲線が100%へ達する上限。狙う人数ごとに200連単位で区切る。 */
const CHART_MAX = { 2: 400, 3: 600, 4: 800 };
/** 呼出ポイントが交換できる区切り。ここが意思決定の分岐点になる。 */
const TABLE_PULLS = { 2: [200, 400], 3: [200, 400, 600], 4: [400, 600, 800] };

function chartData(result) {
  const trim = (values, max) => values.slice(0, max + 1).map((value) => Number(value.toFixed(5)));
  const trimLetters = (values, max) => values.slice(0, max + 1).map((value) => Math.round(value));
  return Object.fromEntries(TARGETS.map((target) => {
    const max = CHART_MAX[target];
    return [target, {
      max,
      chargeBase: trim(result.scenarios.charge[target].allBase, max),
      pointBase: trim(result.scenarios.point[target].allBase, max),
      chargeLetters: trimLetters(result.scenarios.charge[target].letters, max),
      pointLetters: trimLetters(result.scenarios.point[target].letters, max),
    }];
  }));
}

function letterRows(result) {
  return TARGETS.map((target) => {
    const charge = result.scenarios.charge[target];
    const point = result.scenarios.point[target];
    const rows = TABLE_PULLS[target].map((pull, index) => {
      const head = index === 0 ? `<th rowspan="${TABLE_PULLS[target].length}">${target}名</th>` : '';
      const cell = (row, rival) => `<td><b${better(row.letters[pull], rival.letters[pull], true)}>${Math.round(row.letters[pull])}文字</b><small>＋${Math.round(row.shards[pull])}欠片</small></td>`;
      const gap = point.letters[pull] - charge.letters[pull];
      return `<tr>${head}<th class="sub">${pull}連</th>${cell(charge, point)}${cell(point, charge)}<td class="${gap >= 0 ? 'plus' : ''}">${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(gap))}文字</td></tr>`;
    }).join('');
    return `<tbody>${rows}</tbody>`;
  });
}

function milestoneRows(result) {
  // 3名を狙った場合の文字を、凸の到達段位に突き合わせる。
  const charge = result.scenarios.charge[3];
  const point = result.scenarios.point[3];
  return MILESTONE_LETTERS.map(({ name, cost }) => {
    // 上限までに届かない段位は言語に依存しない「—」で示す。
    const reachPull = (row) => row.letters.findIndex((value) => value >= cost);
    const show = (pull) => (pull < 0 ? '—' : `${pull}連`);
    const chargePull = reachPull(charge);
    const pointPull = reachPull(point);
    // 早く届いたほうに印を付ける。届かない側は比較から外す。
    const mark = (mine, rival) => (mine >= 0 && (rival < 0 || mine < rival) ? ' class="best"' : '');
    return `<tr><th>${name}</th><td>${cost}文字</td><td${mark(chargePull, pointPull)}>${show(chargePull)}</td><td${mark(pointPull, chargePull)}>${show(pointPull)}</td></tr>`;
  });
}

function riskRows(result) {
  return TARGETS.map((target) => {
    const p = result.scenarios.charge[target].pullsAtPercentile;
    return `<tr><th>${target}名</th><td>${p['0.5']}連</td><td>${p['0.75']}連</td><td>${p['0.9']}連</td><td>${target * 200}連</td></tr>`;
  });
}

/** 差がある場合だけ有利な側へ印を付ける。到達率は高い方、期待回数は少ない方が有利。 */
function better(value, rival, preferHigh) {
  const wins = preferHigh ? value > rival + 1e-9 : value < rival - 1e-9;
  return wins ? ' class="best"' : '';
}

function reachRows(result) {
  return TARGETS.map((target) => {
    const charge = result.scenarios.charge[target];
    const point = result.scenarios.point[target];
    const rows = TABLE_PULLS[target].map((pull, index) => {
      const head = index === 0 ? `<th rowspan="${TABLE_PULLS[target].length}">${target}名</th>` : '';
      const cell = (row, rival) => `<td><b${better(row.allBase[pull], rival.allBase[pull], true)}>${pct(row.allBase[pull])}</b><small>素体</small><b${better(row.allBonus[pull], rival.allBonus[pull], true)}>${pct(row.allBonus[pull])}</b><small>ボーナス</small></td>`;
      return `<tr>${head}<th class="sub">${pull}連</th>${cell(charge, point)}${cell(point, charge)}</tr>`;
    }).join('');
    return `<tbody>${rows}</tbody>`;
  });
}

function expectationRows(result) {
  return TARGETS.map((target) => {
    const charge = result.scenarios.charge[target];
    const point = result.scenarios.point[target];
    const cell = (row, rival) => `<td><b${better(row.expectedPullsToAllBase, rival.expectedPullsToAllBase, false)}>${row.expectedPullsToAllBase.toFixed(1)}連</b><small>素体</small><b${better(row.expectedPullsToAllBonus, rival.expectedPullsToAllBonus, false)}>${row.expectedPullsToAllBonus.toFixed(1)}連</b><small>ボーナス</small></td>`;
    return `<tr><th>${target}名</th>${cell(charge, point)}${cell(point, charge)}</tr>`;
  });
}

const FESTIVAL_CSS = ':root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e;--series-charge:#14506e;--series-point:#9a6a00;--grid-minor:#e3d9c9;--grid-major:#a99c8e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible,button:focus-visible,.chart-shell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(1100px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}h1,h2{font-size:17px;font-weight:600;line-height:1.3}h3{font-size:15px;font-weight:600;margin:0 0 8px}.hero{padding:16px 0 24px}.header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.hero h1{margin:0}.lead{color:var(--muted);margin:8px 0 0}.repo-link{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-decoration:none}.repo-link:hover{color:var(--link)}.repo-link svg{width:20px;height:20px;flex:none}.panel{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}.panel h2{margin:0 0 12px}.panel p{margin:0 0 12px}.panel p:last-child{margin-bottom:0}.rules{margin:0;padding:0;list-style:none}.rules li{padding:6px 0;border-bottom:1px dashed var(--border);font-size:15px}.rules li:last-child{border-bottom:0}.rules b{color:var(--accent)}.modes{display:flex;gap:4px;margin:0 0 12px}.modes button{flex:1 1 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--muted);font:500 15px/1.2 system-ui,sans-serif;cursor:pointer}.modes button[aria-pressed="true"]{background:var(--accent-subtle);border-color:var(--accent);color:var(--on)}.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}.legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:12px;margin:0 0 8px}.legend i{display:inline-block;width:24px;margin-right:4px;vertical-align:middle;border-top:3px solid}.legend .charge{border-color:var(--series-charge)}.legend .point{border-color:var(--series-point);border-top-style:dashed}.chart-shell{position:relative;border-radius:6px;touch-action:pan-y}.chart-shell svg{display:block;width:100%;height:auto;overflow:visible}.grid line.horizontal{stroke:var(--grid-minor);stroke-width:1}.grid line.minor{stroke:var(--grid-minor);stroke-width:.6}.grid line.major{stroke:var(--grid-major);stroke-width:1}.grid text{fill:var(--muted);font:12px system-ui,sans-serif;text-anchor:middle}.grid .y-label{text-anchor:end}.curve{fill:none;stroke-width:4;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}.curve.charge{stroke:var(--series-charge)}.curve.point{stroke:var(--series-point);stroke-dasharray:10 7}.hit{fill:transparent;cursor:crosshair}.hover-dot{display:none;pointer-events:none;stroke:var(--raised);stroke-width:2}.hover-dot.charge{fill:var(--series-charge)}.hover-dot.point{fill:var(--series-point)}.chart-tip{position:absolute;display:none;max-width:calc(100% - 16px);pointer-events:none;background:var(--raised);color:var(--on);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;line-height:1.5;text-align:left;white-space:pre-line;font-variant-numeric:tabular-nums;z-index:3}table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}th,td{padding:8px 6px;border-bottom:1px solid var(--border);text-align:right;vertical-align:top}thead th{text-align:center;color:var(--muted);font-size:13px;font-weight:600}tbody th{text-align:left;font-size:14px;white-space:nowrap}tbody th.sub{color:var(--muted);font-weight:500}td b{display:block;font-size:15px;font-weight:600;white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px;line-height:1.3;margin-bottom:4px}td small:last-child{margin-bottom:0}tbody+tbody th,tbody+tbody td{border-top:2px solid var(--grid-major)}b.best{color:var(--link)}b.best:after{content:"\\2009\\25B8";font-size:11px;vertical-align:1px}.best{color:var(--link);font-weight:600}.note{color:var(--muted);font-size:14px;margin:12px 0 0}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}@media(max-width:760px){main{width:min(100% - 16px,1100px);margin:16px auto}.panel{padding:12px 8px}.charts{grid-template-columns:1fr}.curve{stroke-width:6}.hero{padding-top:8px}.repo-link span{display:none}th,td{padding:8px 4px}.rules li{font-size:14px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff;--series-charge:#7fdbff;--series-point:#e0a800;--grid-minor:#333;--grid-major:#666}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}';

const GITHUB_LINK = '<a class="repo-link" href="https://github.com/miyabisun/arona-gacha-calc" aria-label="GitHubリポジトリを開く"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.5 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/></svg><span>miyabisun/arona-gacha-calc</span></a>';

const FESTIVAL_SCRIPT = `const W=920,H=430,L=58,R=18,T=18,B=42,PW=W-L-R,PH=H-T-B;const modes=[...document.querySelectorAll('[data-mode]')];let target=3;
function path(values,max){return values.map((value,pull)=>(pull?'L':'M')+(L+pull/max*PW).toFixed(2)+','+(T+(1-value)*PH).toFixed(2)).join(' ')}
const TIERS=[['星4',100],['固有1',220],['固有2',340],['固有3',520],['固有4',720]];
function markup(charge,point,max,label,scale){const ys=(scale?TIERS.filter(t=>t[1]<=scale).map(t=>[t[1]/scale,t[0]]):[0,.25,.5,.75,1].map(v=>[v,(v*100)+'%'])).map(([value,text])=>{const y=T+(1-value)*PH;return '<line class="horizontal" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'"/><text class="y-label" x="'+(L-10)+'" y="'+(y+4)+'">'+text+'</text>'}).join(''),xs=Array.from({length:Math.floor(max/50)+1},(_,i)=>i*50).map(pull=>{const x=L+pull/max*PW,major=pull%200===0;return '<line class="'+(major?'major':'minor')+'" x1="'+x+'" y1="'+T+'" x2="'+x+'" y2="'+(H-B)+'"/>'+(major?'<text class="x-label" x="'+x+'" y="'+(H-14)+'">'+pull+'</text>':'')}).join('');return '<div class="chart-shell" tabindex="0" aria-label="'+label+'。左右矢印で1連、Page UpとPage Downで10連、HomeとEndで移動できます"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+label+'"><g class="grid">'+ys+xs+'</g><path class="curve point" d="'+path(point,max)+'"/><path class="curve charge" d="'+path(charge,max)+'"/><rect class="hit" x="'+L+'" y="'+T+'" width="'+PW+'" height="'+PH+'"/><circle class="hover-dot point" r="5"/><circle class="hover-dot charge" r="5"/></svg><output class="chart-tip" aria-live="polite"></output></div>'}
function wire(host,charge,point,max,noun,scale){const fmt=value=>scale?Math.round(value*scale)+'文字':(value*100).toFixed(2)+'%';const shell=host.querySelector('.chart-shell'),svg=shell.querySelector('svg'),hit=shell.querySelector('.hit'),tip=shell.querySelector('.chart-tip'),chargeDot=shell.querySelector('.hover-dot.charge'),pointDot=shell.querySelector('.hover-dot.point');let current=0;const show=pull=>{current=Math.max(0,Math.min(max,pull));const x=L+current/max*PW,chargeY=T+(1-charge[current])*PH,pointY=T+(1-point[current])*PH;for(const [dot,y] of [[chargeDot,chargeY],[pointDot,pointY]]){dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.style.display='block'}tip.style.display='block';tip.textContent=current+'連 '+noun+'\\n呼出チャージ '+fmt(charge[current])+'\\n呼出ポイント '+fmt(point[current]);const rect=svg.getBoundingClientRect(),pointLeft=x/W*rect.width,pointTop=pointY/H*rect.height,tipWidth=tip.offsetWidth;tip.style.left=Math.max(4,Math.min(rect.width-tipWidth-4,pointLeft+8))+'px';tip.style.top=(pointTop+8)+'px'};const hide=()=>{if(document.activeElement===shell)return;tip.style.display='none';chargeDot.style.display='none';pointDot.style.display='none'};hit.addEventListener('pointermove',event=>{const rect=svg.getBoundingClientRect(),svgX=(event.clientX-rect.left)/rect.width*W;show(Math.round(Math.max(0,Math.min(1,(svgX-L)/PW))*max))});hit.addEventListener('pointerleave',hide);shell.addEventListener('focus',()=>show(current));shell.addEventListener('blur',hide);shell.addEventListener('keydown',event=>{const moves={ArrowLeft:-1,ArrowRight:1,PageUp:10,PageDown:-10};let next=current;if(event.key in moves)next+=moves[event.key];else if(event.key==='Home')next=0;else if(event.key==='End')next=max;else return;event.preventDefault();show(next)})}
function render(){const series=DATA[target],max=series.max;const top=Math.max(720,Math.ceil(Math.max(series.chargeLetters[max],series.pointLetters[max])/100)*100);
const asRatio=values=>values.map(value=>value/top);
for(const [id,charge,point,noun,scale] of [['chart-letters',asRatio(series.chargeLetters),asRatio(series.pointLetters),'文字',top],['chart-base',series.chargeBase,series.pointBase,'素体',0]]){const host=document.getElementById(id),label=scale?target+'名を狙ったときの期待文字数':target+'名の素体を全員分そろえる累積確率';host.innerHTML=markup(charge,point,max,label,scale);wire(host,charge,point,max,noun,scale)}
modes.forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.mode)===target)))}
modes.forEach(button=>button.addEventListener('click',()=>{target=Number(button.dataset.mode);render()}));render();`;

function renderFestivalHtml(result) {
  const data = JSON.stringify(chartData(result)).replaceAll('<', '\\u003c');
  const rates = result.rates;
  const banking = result.banking;
  const modes = TARGETS.map((target) => `<button type="button" data-mode="${target}" aria-pressed="${target === 3}">${target}名</button>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5フェス限の新旧比較</title><style>
${FESTIVAL_CSS}
</style></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5フェス限の新旧比較</h1>${GITHUB_LINK}</div><p class="lead">フェス限定募集は星3が6%へ倍化し、指名していないフェス限生徒も出現します。この「すり抜け」で狙っている別の生徒が手に入るため、呼出ポイントの200連区切りが有利になる場面があります。</p></header>
<section class="panel"><h2>計算に使う前提</h2><ul class="rules"><li>フェス限定募集の星3排出率は <b>${pct(rates.festivalStar3)}</b>。</li><li>指名した1名の排出率は <b>${pct(rates.namedPu)}</b>。呼出チャージではチャージ99で50%、199で100%。</li><li>新旧フェス限10名から指名中の1名を除いた<b>9名</b>が <b>${pct(rates.spookPoolTotal)}</b> を等分し、1名あたり <b>${pct(rates.spookEach)}</b>。</li><li>残る <b>${pct(rates.otherStar3)}</b> は恒常星3で、内訳として記録するだけで計算には使いません。</li><li>初回PUボーナスは<b>指名PUの自引きと呼出ポイント交換</b>でのみ得られます。すり抜けで確保しても付きません。</li><li>素体を持たない生徒を優先して指名し、全員が素体済みなら素体持ちを指名してボーナスだけ回収します。</li></ul></section>
<section class="panel"><h2>持ち帰る文字と、そろう確率</h2><div class="modes" role="group" aria-label="狙う人数">${modes}</div><div class="legend" aria-label="グラフの凡例"><span><i class="charge"></i>呼出チャージ（実線）</span><span><i class="point"></i>呼出ポイント（破線）</span></div><div class="charts"><div><h3>期待文字数</h3><div id="chart-letters"></div></div><div><h3>全員の素体がそろう確率</h3><div id="chart-base"></div></div></div><p class="note">左の横線は上から固有4（720文字）、固有3（520）、固有2（340）、固有1（220）、星4（100）です。素体がそろうことはゴールではなく、凸を進める文字がいくつ残ったかが成果になります。</p></section>
<section class="panel"><h2>区切りごとに持ち帰る文字</h2><table><colgroup><col style="width:14%"><col style="width:14%"><col style="width:26%"><col style="width:26%"><col style="width:20%"></colgroup><thead><tr><th>狙う人数</th><th>連数</th><th>呼出チャージ</th><th>呼出ポイント</th><th>差</th></tr></thead>${letterRows(result).join('')}</table><p class="note">狙う人数を変えても文字数はほとんど動きません。文字は「何人狙ったか」ではなく「何回引き当てたか」で決まるためです。呼出ポイントが一貫して上回るのは、0.7%の自引きと200ptの交換が独立に走り、同じ200連あたりの獲得機会が多いからです（呼出チャージ2.22回に対し呼出ポイント2.40回）。</p></section>
<section class="panel"><h2>凸のどこまで届くか</h2><table><colgroup><col style="width:22%"><col style="width:22%"><col style="width:28%"><col style="width:28%"></colgroup><thead><tr><th>到達段位</th><th>必要文字</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead><tbody>${milestoneRows(result).join('')}</tbody></table><p class="note">3名を狙った場合に、対象3名分を合計した文字が段位のコストへ届く連数です。1名へ集中させた場合の数字ではありません。星3を出発点として星4に100文字、固有1にさらに120文字、固有2に120文字、固有3に180文字、固有4に200文字が必要です。</p></section>
<section class="panel"><h2>区切りまで回したときの到達率</h2><table><colgroup><col style="width:16%"><col style="width:16%"><col style="width:34%"><col style="width:34%"></colgroup><thead><tr><th>狙う人数</th><th>連数</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead>${reachRows(result).join('')}</table><p class="note">呼出ポイントは200連ごとに1名を確実に交換できるため、区切りちょうどで見ると呼出チャージより高くなります。狙う人数が増えるほど差は開きます。</p></section>
<section class="panel"><h2>降りどきが選べるかどうか</h2><p>呼出チャージは全員そろうまで降りにくく、呼出ポイントは200連ごとに続行か撤退かを選べます。下は呼出チャージで全員の素体がそろう連数の散らばりで、半分の先生は中央値で降りられますが、残り半分はそこから先も払い続けることになります。</p><table><colgroup><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup><thead><tr><th>狙う人数</th><th>半数</th><th>4人に3人</th><th>10人に9人</th><th>最悪</th></tr></thead><tbody>${riskRows(result).join('')}</tbody></table><p class="note">呼出ポイントなら200連で1名分の交換が確定するため、同じ予算を決め打ちで投じても手ぶらになりません。呼出チャージは天井が200連ごとに区切られる点は同じですが、自引きがそのままチャージを消費するので、取得機会が交換ぶんだけ少なくなります。</p></section>
<section class="panel"><h2>すり抜け狙いは作戦になるか</h2><p>指名した生徒を引き当てる前にすり抜けが来れば、その生徒を交換に回して<b>重複100文字＋初回ボーナス100文字＋50欠片</b>を一度に得られます。狙う価値があるかを測るため、1人目を引き当てるまでにすり抜けが来る確率を出しました。</p><table><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup><thead><tr><th>待っている枠</th><th>呼出チャージ</th><th>呼出ポイント</th><th>差</th></tr></thead><tbody><tr><th>1枠</th><td>8.43%</td><td class="best">12.50%</td><td>+4.07pt</td></tr><tr><th>2枠</th><td>15.86%</td><td class="best">22.22%</td><td>+6.36pt</td></tr><tr><th>3枠</th><td>22.45%</td><td class="best">30.00%</td><td>+7.55pt</td></tr></tbody></table><p class="note">呼出ポイントが上回るのは、1人目にかかる平均が142.9連と長く、その間ずっと枠が生きているからです。呼出チャージは90.1連で決着してしまい、100連目の50%と200連目の確定枠に待ち時間を打ち切られます。</p><p class="note">ただし、これを積極的に狙う価値はありません。すり抜け済みの生徒を優先して交換に回しても、400連で得られる文字は3文字しか増えず（3名狙いで504文字が507文字）、素体のそろう確率は2.7pt下がります。さらに、すり抜け枠を保つために既所持の生徒を指名し続ける「片方寄せ」まで踏み込むと、文字は36文字増える一方で素体は29.7pt落ちます。指名は0.7%、すり抜けは1枠あたり0.1%です。3.5倍強い手段を捨てて枠を温存する取引は、どう組んでも割に合いません。</p></section>
<section class="panel"><h2>そろうまでの期待募集回数</h2><table><colgroup><col style="width:20%"><col style="width:40%"><col style="width:40%"></colgroup><thead><tr><th>狙う人数</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead><tbody>${expectationRows(result).join('')}</tbody></table><p class="note">区切りを気にせず引き続けた場合の平均です。到達率の表とは逆に、2名・3名では呼出チャージのほうが短く済みます。区切りで止めるか揃うまで回すかで、有利な仕様が入れ替わります。</p></section>
<section class="panel"><h2>99連を次の限定募集へ持ち越す</h2><p>呼出チャージは募集の種別ごとに引き継がれます。フェス限定募集で貯めたチャージは<b>次の限定募集やフェス限定募集</b>へ、恒常募集のチャージは次の恒常募集へ持ち越せます。</p><p>そこで、フェス限定募集の期間に<b>99連まで進めて止めておき</b>、次の限定募集をチャージ99の状態で始める作戦が成立します。1連目にいきなり50%の確定枠が来て、外しても<b>${banking.guaranteedWithinBanked}連目</b>には199の確定枠へ届きます。</p><table><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup><thead><tr><th>1人を確保するまで</th><th>期待</th><th>最大</th><th>短縮</th></tr></thead><tbody><tr><th>チャージ0から</th><td>${banking.expectedPullsPlain.toFixed(1)}連</td><td>${banking.guaranteedWithinPlain}連</td><td>—</td></tr><tr><th>チャージ99から</th><td class="best">${banking.expectedPullsBanked.toFixed(1)}連</td><td class="best">${banking.guaranteedWithinBanked}連</td><td class="best">−${banking.savedPulls.toFixed(1)}連</td></tr></tbody></table><p class="note">持ち越したチャージは1人目にしか効かないため、短縮量は狙う人数によらず一定です。表の連数には、貯めるために使った99連そのものを含みません。</p><h3>どこで99連を貯めるか</h3><p>同じ99連でも、貯める場所によって副産物が変わります。フェス限定募集は星3が <b>${pct(rates.festivalStar3)}</b> なので99連あたり期待 <b>${banking.festivalStar3PerBank.toFixed(2)}人</b>。限定募集は <b>${pct(rates.limitedStar3)}</b> のままなので <b>${banking.limitedStar3PerBank.toFixed(2)}人</b> にとどまります。貯めるなら星3が倍のフェス限定募集のあいだに進めておくほうが、同じ連数で多く拾えます。</p><p class="note">ただし恒常星3の価値は1人あたり30文字と50欠片で、欲しい生徒が恒常の分母にどれだけ含まれるか次第です。「倍拾える」がそのまま「倍うれしい」にはなりません。</p><p class="note">また、貯めている途中で指名した生徒を引き当てるとチャージは0に戻ります。99連を引ききってもチャージが残っている確率は <b>${pct(banking.survivalToBank)}</b> です。199連まで貯めて次の募集を1連で終わらせる案は、そこへ到達する前に約87.5%がチャージを失うため実用になりません。</p></section>
<footer>Generated by scripts/festival.js</footer></main>
<script>const DATA=${data};${FESTIVAL_SCRIPT}</script></body></html>`;
}

/**
 * 英語版。置換は配列順に適用され、後段のパターンは前段適用後の文字列を指す。
 * 長い一文から先に置換し、最後に短い語を置き換える。
 */
const ENGLISH_REPLACEMENTS = [
  ['<html lang="ja">', '<html lang="en">'],
  ['<title>5.5フェス限の新旧比較</title>', '<title>5.5th Anniversary Festival Comparison</title>'],
  ['<h1>5.5フェス限の新旧比較</h1>', '<h1>5.5th Anniversary Festival Comparison</h1>'],
  ['aria-label="GitHubリポジトリを開く"', 'aria-label="Open the GitHub repository"'],
  [
    'フェス限定募集は星3が6%へ倍化し、指名していないフェス限生徒も出現します。この「すり抜け」で狙っている別の生徒が手に入るため、呼出ポイントの200連区切りが有利になる場面があります。',
    'Festival recruitment doubles the 3★ rate to 6%, and festival students you did not select can also appear. Because such an off-target pull can still hand you another student you wanted, the 200-pull milestones of Recruitment Points become competitive.',
  ],
  ['<h2>計算に使う前提</h2>', '<h2>Assumptions</h2>'],
  ['<li>フェス限定募集の星3排出率は <b>6.00%</b>。</li>', '<li>The 3★ rate during festival recruitment is <b>6.00%</b>.</li>'],
  [
    '<li>指名した1名の排出率は <b>0.70%</b>。呼出チャージではチャージ99で50%、199で100%。</li>',
    '<li>The student you select appears at <b>0.70%</b>. Under Recruitment Charge, that becomes 50% at charge 99 and 100% at charge 199.</li>',
  ],
  [
    '<li>新旧フェス限10名から指名中の1名を除いた<b>9名</b>が <b>0.90%</b> を等分し、1名あたり <b>0.10%</b>。</li>',
    '<li>The <b>9</b> remaining festival students — 10 in total, minus the one you selected — share <b>0.90%</b> equally, giving <b>0.10%</b> each.</li>',
  ],
  [
    '<li>残る <b>4.40%</b> は恒常星3で、内訳として記録するだけで計算には使いません。</li>',
    '<li>The remaining <b>4.40%</b> covers permanent 3★ students. It is recorded for completeness but never used in the calculation.</li>',
  ],
  [
    '<li>初回PUボーナスは<b>指名PUの自引きと呼出ポイント交換</b>でのみ得られます。すり抜けで確保しても付きません。</li>',
    '<li>The first-time pickup bonus is granted only by <b>pulling the student you selected or exchanging Recruitment Points</b>. An off-target pull never grants it.</li>',
  ],
  [
    '<li>素体を持たない生徒を優先して指名し、全員が素体済みなら素体持ちを指名してボーナスだけ回収します。</li>',
    '<li>The strategy always selects a student you do not own yet; once every student is owned, it selects an owned one to collect the remaining bonuses.</li>',
  ],
  ['<h2>持ち帰る文字と、そろう確率</h2>', '<h2>Eleph earned, and the odds of completing</h2>'],
  ['aria-label="狙う人数"', 'aria-label="Number of students targeted"'],
  ['aria-label="グラフの凡例"', 'aria-label="Chart legend"'],
  ['呼出チャージ（実線）', 'Recruitment Charge (solid)'],
  ['呼出ポイント（破線）', 'Recruitment Points (dashed)'],
  ['<h3>期待文字数</h3>', '<h3>Expected Eleph</h3>'],
  ['<h3>全員の素体がそろう確率</h3>', '<h3>Chance every student is owned</h3>'],
  [
    '<p class="note">左の横線は上から固有4（720文字）、固有3（520）、固有2（340）、固有1（220）、星4（100）です。素体がそろうことはゴールではなく、凸を進める文字がいくつ残ったかが成果になります。</p>',
    '<p class="note">The guides on the left chart mark UE4 (720 Eleph), UE3 (520), UE2 (340), UE1 (220) and 5★ (100), top to bottom. Owning the students is not the finish line — what matters is how much Eleph you carry away toward those upgrades.</p>',
  ],
  ['<h2>区切りごとに持ち帰る文字</h2>', '<h2>Eleph earned at each milestone</h2>'],
  ['<th>差</th>', '<th>Gap</th>'],
  [
    '<p class="note">狙う人数を変えても文字数はほとんど動きません。文字は「何人狙ったか」ではなく「何回引き当てたか」で決まるためです。呼出ポイントが一貫して上回るのは、0.7%の自引きと200ptの交換が独立に走り、同じ200連あたりの獲得機会が多いからです（呼出チャージ2.22回に対し呼出ポイント2.40回）。</p>',
    '<p class="note">Targeting more students barely changes the Eleph total, because Eleph depends on how many times you hit — not on how many students you were after. Recruitment Points stays ahead because its 0.7% pulls and its 200-point exchange run independently, giving more chances per 200 pulls (2.40 against 2.22 for Recruitment Charge).</p>',
  ],
  ['<h2>凸のどこまで届くか</h2>', '<h2>How far up the upgrade track</h2>'],
  ['<th>到達段位</th>', '<th>Upgrade</th>'],
  ['<th>必要文字</th>', '<th>Eleph cost</th>'],
  [
    '<p class="note">3名を狙った場合に、対象3名分を合計した文字が段位のコストへ届く連数です。1名へ集中させた場合の数字ではありません。星3を出発点として星4に100文字、固有1にさらに120文字、固有2に120文字、固有3に180文字、固有4に200文字が必要です。</p>',
    '<p class="note">Pull counts at which the Eleph earned across all three targeted students reaches each cost. These are not the figures for funnelling everything into one student. Starting from 3★, reaching 5★ costs 100 Eleph, then UE1 a further 120, UE2 another 120, UE3 another 180, and UE4 another 200.</p>',
  ],
  ['文字</b>', ' Eleph</b>'],
  ['＋', '+'],
  ['欠片</small>', ' shards</small>'],
  ['文字</td>', ' Eleph</td>'],
  ['<th>星4</th>', '<th>5★</th>'],
  ['<th>固有1</th>', '<th>UE1</th>'],
  ['<th>固有2</th>', '<th>UE2</th>'],
  ['<th>固有3</th>', '<th>UE3</th>'],
  ['<th>固有4</th>', '<th>UE4</th>'],
  ["TIERS=[['星4',100],['固有1',220],['固有2',340],['固有3',520],['固有4',720]]", "TIERS=[['5★',100],['UE1',220],['UE2',340],['UE3',520],['UE4',720]]"],
  ["Math.round(value*scale)+'文字'", "Math.round(value*scale)+' Eleph'"],
  ["target+'名を狙ったときの期待文字数'", "'Expected Eleph when targeting '+target+(target===1?' student':' students')"],
  ["target+'名の素体を全員分そろえる累積確率'", "'Cumulative probability of owning all '+target+(target===1?' student':' students')"],
  ["'文字',top]", "'Eleph',top]"],
  ["'素体',0]", "'owned',0]"],
  ['<h2>区切りまで回したときの到達率</h2>', '<h2>Results at each milestone</h2>'],
  [
    '<p class="note">呼出ポイントは200連ごとに1名を確実に交換できるため、区切りちょうどで見ると呼出チャージより高くなります。狙う人数が増えるほど差は開きます。</p>',
    '<p class="note">Recruitment Points guarantee one exchange every 200 pulls, so exactly at a milestone it beats Recruitment Charge. The gap widens as you target more students.</p>',
  ],
  ['<h2>降りどきが選べるかどうか</h2>', '<h2>Whether you get to walk away</h2>'],
  [
    '<p>呼出チャージは全員そろうまで降りにくく、呼出ポイントは200連ごとに続行か撤退かを選べます。下は呼出チャージで全員の素体がそろう連数の散らばりで、半分の先生は中央値で降りられますが、残り半分はそこから先も払い続けることになります。</p>',
    '<p>Recruitment Charge is hard to walk away from until everyone is owned, whereas Recruitment Points lets you decide whether to continue every 200 pulls. Below is the spread of pulls needed to own every student under Recruitment Charge: half of players stop at the median, and the other half keep paying past it.</p>',
  ],
  ['<th>半数</th>', '<th>Half</th>'],
  ['<th>4人に3人</th>', '<th>3 in 4</th>'],
  ['<th>10人に9人</th>', '<th>9 in 10</th>'],
  ['<th>最悪</th>', '<th>Worst case</th>'],
  [
    '<p class="note">呼出ポイントなら200連で1名分の交換が確定するため、同じ予算を決め打ちで投じても手ぶらになりません。呼出チャージは天井が200連ごとに区切られる点は同じですが、自引きがそのままチャージを消費するので、取得機会が交換ぶんだけ少なくなります。</p>',
    '<p class="note">Recruitment Points guarantees one exchange at 200 pulls, so committing a fixed budget never leaves you empty-handed. Recruitment Charge also guarantees a student every 200 pulls, but because pulling one consumes the charge, it ends up with fewer acquisition chances by exactly the value of that exchange.</p>',
  ],
  ['<h2>すり抜け狙いは作戦になるか</h2>', '<h2>Is chasing off-target pulls a strategy?</h2>'],
  [
    // このパターンより前で「＋」が半角に置換済みのため、置換後の姿で指定する。
    '<p>指名した生徒を引き当てる前にすり抜けが来れば、その生徒を交換に回して<b>重複100文字+初回ボーナス100文字+50欠片</b>を一度に得られます。狙う価値があるかを測るため、1人目を引き当てるまでにすり抜けが来る確率を出しました。</p>',
    '<p>If an off-target pull lands before you hit the student you selected, exchanging for that same student pays <b>100 Eleph for the duplicate, 100 more from the unspent first-time bonus, and 50 shards</b> all at once. To judge whether that is worth chasing, here is the chance an off-target pull arrives before your first hit.</p>',
  ],
  ['<th>待っている枠</th>', '<th>Slots waiting</th>'],
  ['<th>1枠</th>', '<th>1 slot</th>'],
  ['<th>2枠</th>', '<th>2 slots</th>'],
  ['<th>3枠</th>', '<th>3 slots</th>'],
  [
    '<p class="note">呼出ポイントが上回るのは、1人目にかかる平均が142.9連と長く、その間ずっと枠が生きているからです。呼出チャージは90.1連で決着してしまい、100連目の50%と200連目の確定枠に待ち時間を打ち切られます。</p>',
    '<p class="note">Recruitment Points wins here because its first hit takes 142.9 pulls on average, keeping the slots alive that whole time. Recruitment Charge settles in 90.1 pulls, with the 50% slot at pull 100 and the guarantee at pull 200 cutting the wait short.</p>',
  ],
  [
    '<p class="note">ただし、これを積極的に狙う価値はありません。すり抜け済みの生徒を優先して交換に回しても、400連で得られる文字は3文字しか増えず（3名狙いで504文字が507文字）、素体のそろう確率は2.7pt下がります。さらに、すり抜け枠を保つために既所持の生徒を指名し続ける「片方寄せ」まで踏み込むと、文字は36文字増える一方で素体は29.7pt落ちます。指名は0.7%、すり抜けは1枠あたり0.1%です。3.5倍強い手段を捨てて枠を温存する取引は、どう組んでも割に合いません。</p>',
    '<p class="note">Chasing it deliberately is still not worth it. Prioritising an off-target student for the exchange adds only 3 Eleph over 400 pulls (504 becomes 507 when targeting three), while the chance of owning everyone drops 2.7pt. Going further and holding a student you already own just to keep the slots open gains 36 Eleph but costs 29.7pt of completion. Selecting is a 0.7% chance; each waiting slot is 0.1%. Trading away a method 3.5 times stronger to preserve those slots never pays off.</p>',
  ],
  ['<h2>そろうまでの期待募集回数</h2>', '<h2>Expected pulls needed</h2>'],
  [
    '<p class="note">区切りを気にせず引き続けた場合の平均です。到達率の表とは逆に、2名・3名では呼出チャージのほうが短く済みます。区切りで止めるか揃うまで回すかで、有利な仕様が入れ替わります。</p>',
    '<p class="note">This is the long-run average when you keep pulling past the milestones. Opposite to the table above, Recruitment Charge finishes sooner for 2 and 3 students. Which system wins depends on whether you stop at a milestone or pull until everything is complete.</p>',
  ],
  ['<h2>99連を次の限定募集へ持ち越す</h2>', '<h2>Carrying 99 pulls into the next limited banner</h2>'],
  [
    '<p>呼出チャージは募集の種別ごとに引き継がれます。フェス限定募集で貯めたチャージは<b>次の限定募集やフェス限定募集</b>へ、恒常募集のチャージは次の恒常募集へ持ち越せます。</p>',
    '<p>Recruitment Charge carries over within a banner category. Charge built up on a festival banner carries into <b>the next limited or festival banner</b>, while charge from the standard banner carries into the next standard banner.</p>',
  ],
  [
    '<p>そこで、フェス限定募集の期間に<b>99連まで進めて止めておき</b>、次の限定募集をチャージ99の状態で始める作戦が成立します。1連目にいきなり50%の確定枠が来て、外しても<b>101連目</b>には199の確定枠へ届きます。</p>',
    '<p>That makes a plan possible: <b>stop at 99 pulls</b> during the festival banner, then open the next limited banner already at charge 99. The 50% guaranteed slot lands on your very first pull, and even if it misses, the charge-199 guarantee arrives on the <b>101st pull</b>.</p>',
  ],
  ['<th>1人を確保するまで</th>', '<th>To secure one student</th>'],
  ['<th>期待</th>', '<th>Expected</th>'],
  ['<th>最大</th>', '<th>Worst case</th>'],
  ['<th>短縮</th>', '<th>Saved</th>'],
  ['<th>チャージ0から</th>', '<th>From charge 0</th>'],
  ['<th>チャージ99から</th>', '<th>From charge 99</th>'],
  [
    '<p class="note">持ち越したチャージは1人目にしか効かないため、短縮量は狙う人数によらず一定です。表の連数には、貯めるために使った99連そのものを含みません。</p>',
    '<p class="note">Carried-over charge only helps with the first student, so the saving is the same no matter how many students you target. The pull counts above exclude the 99 pulls spent building the charge.</p>',
  ],
  ['<h3>どこで99連を貯めるか</h3>', '<h3>Where to build the charge</h3>'],
  [
    '<p>同じ99連でも、貯める場所によって副産物が変わります。フェス限定募集は星3が <b>6.00%</b> なので99連あたり期待 <b>5.94人</b>。限定募集は <b>3.00%</b> のままなので <b>2.97人</b> にとどまります。貯めるなら星3が倍のフェス限定募集のあいだに進めておくほうが、同じ連数で多く拾えます。</p>',
    '<p>The same 99 pulls yield different by-products depending on where you spend them. A festival banner runs 3★ at <b>6.00%</b>, so 99 pulls return <b>5.94</b> of them on average, while a limited banner stays at <b>3.00%</b> and returns only <b>2.97</b>. Building the charge during a festival banner collects roughly twice as much for the same number of pulls.</p>',
  ],
  [
    '<p class="note">ただし恒常星3の価値は1人あたり30文字と50欠片で、欲しい生徒が恒常の分母にどれだけ含まれるか次第です。「倍拾える」がそのまま「倍うれしい」にはなりません。</p>',
    '<p class="note">A duplicate permanent 3★ is worth 30 Eleph and 50 shards, so how much that matters depends on how many students you actually want inside the permanent pool. Twice the pulls does not mean twice the value.</p>',
  ],
  [
    '<p class="note">また、貯めている途中で指名した生徒を引き当てるとチャージは0に戻ります。99連を引ききってもチャージが残っている確率は <b>49.89%</b> です。199連まで貯めて次の募集を1連で終わらせる案は、そこへ到達する前に約87.5%がチャージを失うため実用になりません。</p>',
    '<p class="note">Pulling the student you selected resets the charge to 0, so the plan only survives half the time: the chance of still holding the charge after 99 pulls is <b>49.89%</b>. Banking all the way to 199 to finish the next banner in a single pull fails even more often — about 87.5% lose the charge before reaching it.</p>',
  ],
  ['<th>狙う人数</th>', '<th>Students</th>'],
  ['<th>連数</th>', '<th>Pulls</th>'],
  ['<th>呼出チャージ</th>', '<th>Recruitment Charge</th>'],
  ['<th>呼出ポイント</th>', '<th>Recruitment Points</th>'],
  // クライアント側の文言。ラベルは英語の語順に組み替える。
  ["current+'連 '+noun+'\\n呼出チャージ '", "current+' pulls · '+noun+'\\nRecruitment Charge '"],
  ["'\\n呼出ポイント '", "'\\nRecruitment Points '"],
  ['。左右矢印で1連、Page UpとPage Downで10連、HomeとEndで移動できます', '. Use Left and Right for 1 pull, Page Up and Page Down for 10 pulls, and Home and End to jump'],
  // 短い語は最後に。タグ境界を含めて誤爆を防ぐ。
  ['<small>素体</small>', '<small>owned</small>'],
  ['<small>ボーナス</small>', '<small>bonus</small>'],
  ['連</b>', ' pulls</b>'],
  ['連</td>', ' pulls</td>'],
  ['>2名<', '>2 students<'],
  ['>3名<', '>3 students<'],
  ['>4名<', '>4 students<'],
  ['200連</th>', '200 pulls</th>'],
  ['400連</th>', '400 pulls</th>'],
  ['600連</th>', '600 pulls</th>'],
  ['800連</th>', '800 pulls</th>'],
];

function renderFestival(result, locale = 'ja') {
  const japanese = localizeShell(renderFestivalHtml(result), locale, 'festival');
  if (locale === 'ja') return japanese;
  if (locale !== 'en') throw new Error(`Unsupported locale: ${locale}`);
  return replaceExact(japanese, ENGLISH_REPLACEMENTS);
}

/** 監査用JSONは10連刻みに間引く。曲線をそのまま書くと配布物が肥大するため。 */
function thinForJson(result, step = 10) {
  const thin = (values) => values.filter((_, pull) => pull % step === 0 || pull === values.length - 1);
  const scenarios = Object.fromEntries(Object.entries(result.scenarios).map(([id, byTarget]) => [
    id,
    Object.fromEntries(Object.entries(byTarget).map(([target, row]) => [
      target,
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Array.isArray(value) ? thin(value) : value])),
    ])),
  ]));
  return { ...result, metadata: { ...result.metadata, curveSampleStep: step }, scenarios };
}

function main() {
  const started = process.hrtime.bigint();
  const result = calculateFestival();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'festival-results.json'), `${JSON.stringify(thinForJson(result), null, 2)}\n`);
  fs.mkdirSync(path.join(OUTPUT_DIR, 'en'), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'festival.html'), renderFestival(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'en', 'festival.html'), renderFestival(result, 'en'));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`厳密計算: ${elapsedMs.toFixed(0)}ms  質量誤差: ${result.audit.maxMassError.toExponential(2)}`);
  for (const target of TARGETS) {
    console.log(`\n=== ${target}人狙い ===`);
    console.log('連数  | チャージ素体 ボーナス | ポイント素体 ボーナス | 銀行99素体 ボーナス');
    for (const pull of [200, 400, 600, 800]) {
      const charge = result.scenarios.charge[target];
      const point = result.scenarios.point[target];
      const banked = result.scenarios.chargeBanked[target];
      console.log(`${String(pull).padStart(4)}連 | ${pct(charge.allBase[pull]).padStart(7)} ${pct(charge.allBonus[pull]).padStart(7)} | ${pct(point.allBase[pull]).padStart(7)} ${pct(point.allBonus[pull]).padStart(7)} | ${pct(banked.allBase[pull]).padStart(7)} ${pct(banked.allBonus[pull]).padStart(7)}`);
    }
    for (const id of ['charge', 'point', 'chargeBanked']) {
      const row = result.scenarios[id][target];
      console.log(`${id.padEnd(13)} 期待連数 素体全確保=${row.expectedPullsToAllBase.toFixed(1)} 全ボーナス=${row.expectedPullsToAllBonus.toFixed(1)}`);
    }
  }
}

if (require.main === module) main();

module.exports = {
  calculateFestival,
  renderFestival,
  runFestivalDp,
  applyExchange,
  chargeHitRate,
  chargeResidual,
  expectedPulls,
  shardsToLetters,
  percentilePull,
  SPOOK_EACH_RATE,
  MAX_PULLS,
  TARGETS,
  TABLE_PULLS,
};
