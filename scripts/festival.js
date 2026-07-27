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
const NORMAL_BANNER_STAR3_RATE = 0.03;
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
// 1名を狙い続ける戦略の検討用。今回のPU対象は4名で、本命の凸は固有2を目標に置く。
const FOCUS_TARGETS = 4;
const FOCUS_HIT_CAP = 6;
const FOCUS_MAX_PULLS = 600;
const UE2_LETTERS = 340;
const PYROXENE_PER_PULL = 120;
// 10連あたりに残る欠片の目安。星3が倍になるフェス限では取り分も増える。
// 実測ではなく体感からの概算で、確定値が出たらここだけ差し替えれば全体に反映される。
const SHARDS_PER_TEN_NORMAL = 50;
const SHARDS_PER_TEN_FESTIVAL = 80;
// 拾った欠片のうち、実際に凸へ回せる割合。多くの生徒は育成対象にならず、
// 使う生徒は先に欠片交換で固有2まで上げ終えているため、名目どおりには効かない。
const USEFUL_SHARD_RATIO = 0.1;
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

/** 対象1名をn回引いたときの実効文字。重複ぶんの欠片も文字へ換算して足す。 */
function effectiveLetters(hits) {
  if (hits === 0) return 0;
  return hits * PU_DUPLICATE_LETTERS + shardsToLetters((hits - 1) * DUPLICATE_SHARDS);
}

/**
 * 呼出チャージで「本命→相方の順に指名し、全員の素体がそろったら撤退する」運用。
 * allowSpook=false は、すり抜けが一切起きなかった場合の比較用。
 */
function runRetreat(targets, { allowSpook }, maxPulls = 800) {
  let states = new Map([['0:0:0', 1]]);
  let letters = 0;
  let expected = 0;
  let doneMass = 0;
  let spookUsed = 0;
  for (let pull = 1; pull <= maxPulls; pull += 1) {
    const next = new Map();
    const add = (key, mass) => next.set(key, (next.get(key) ?? 0) + mass);
    for (const [key, mass] of states) {
      const [bonus, spare, charge] = key.split(':').map(Number);
      if (bonus + spare >= targets) { add(key, mass); continue; }
      const hit = chargeHitRate(charge);
      const residual = chargeResidual(charge);
      const baseless = targets - bonus - spare;
      const spook = allowSpook ? residual * Math.max(0, baseless - 1) * SPOOK_EACH_RATE : 0;
      const miss = 1 - hit - spook;
      if (hit > 0) {
        // 指名した生徒なので、初回PUボーナスが必ず付く。
        letters += mass * hit * BONUS_LETTERS;
        add(`${bonus + 1}:${spare}:0`, mass * hit);
      }
      // すり抜けは素体だけ。その生徒の初回PUボーナスは未消費のまま残る。
      if (spook > 0) add(`${bonus}:${spare + 1}:${charge + 1}`, mass * spook);
      if (miss > 0) add(`${bonus}:${spare}:${charge + 1}`, mass * miss);
    }
    states = next;
    let done = 0;
    let viaSpook = 0;
    for (const [key, mass] of states) {
      const [bonus, spare] = key.split(':').map(Number);
      if (bonus + spare >= targets) { done += mass; if (spare > 0) viaSpook += mass; }
    }
    expected += (done - doneMass) * pull;
    doneMass = done;
    spookUsed = viaSpook;
  }
  return { expectedPulls: expected, letters, finishedViaSpook: spookUsed };
}

/**
 * 呼出ポイントで本命1名を指名し続ける運用。
 * plan は200連ごとの交換先で、'sub'=相方を引き取る / 'veteran'=既所持のPU対象 / 'main'=本命。
 * 既所持でボーナス未消費の生徒を引き取ると、重複と初回ボーナスがまとめて入る。
 */
function runFocusExchange(limit, plan) {
  let states = new Map([['0:0', 1]]);
  let letters = 0;
  let index = 0;
  for (let pull = 1; pull <= limit; pull += 1) {
    const next = new Map();
    const add = (key, mass) => next.set(key, (next.get(key) ?? 0) + mass);
    for (const [key, mass] of states) {
      const [main, sub] = key.split(':').map(Number);
      const spook = SPOOK_EACH_RATE;    // 相方は指名外なので常に流れてくる
      const miss = 1 - NORMAL_PU_RATE - spook;
      letters += mass * NORMAL_PU_RATE * PU_DUPLICATE_LETTERS;
      add(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${sub}`, mass * NORMAL_PU_RATE);
      if (sub > 0) letters += mass * spook * SPOOK_DUPLICATE_LETTERS;
      add(`${main}:${Math.min(sub + 1, FOCUS_HIT_CAP)}`, mass * spook);
      add(`${main}:${sub}`, mass * miss);
    }
    states = next;
    if (pull % EXCHANGE_INTERVAL === 0) {
      const target = plan[index] ?? 'main';
      index += 1;
      const exchanged = new Map();
      const add2 = (key, mass) => exchanged.set(key, (exchanged.get(key) ?? 0) + mass);
      for (const [key, mass] of states) {
        const [main, sub] = key.split(':').map(Number);
        if (target === 'sub') {
          letters += mass * (sub === 0 ? BONUS_LETTERS : PU_DUPLICATE_LETTERS + BONUS_LETTERS);
          add2(`${main}:${Math.min(sub + 1, FOCUS_HIT_CAP)}`, mass);
        } else if (target === 'veteran') {
          letters += mass * (PU_DUPLICATE_LETTERS + BONUS_LETTERS);
          add2(key, mass);
        } else {
          letters += mass * PU_DUPLICATE_LETTERS;
          add2(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${sub}`, mass);
        }
      }
      states = exchanged;
    }
  }
  const joint = Array.from({ length: FOCUS_HIT_CAP + 1 }, () => Array(FOCUS_HIT_CAP + 1).fill(0));
  let mainExpected = 0;
  let subExpected = 0;
  let subNone = 0;
  let mainUe2 = 0;
  for (const [key, mass] of states) {
    const [main, sub] = key.split(':').map(Number);
    joint[main][sub] += mass;
    mainExpected += main * mass;
    subExpected += sub * mass;
    if (sub === 0) subNone += mass;
    if (effectiveLetters(main) >= UE2_LETTERS) mainUe2 += mass;
  }
  return { letters, joint, mainExpected, subExpected, subNone, mainUe2 };
}

/**
 * 呼出ポイントの実戦的な進め方。200連ブロック単位で引き、
 * 素体がそろったブロックの終わりで撤退する（文字目当ての追加ブロックは回さない）。
 * 交換枠は未所持がいれば必ずそこへ使い、フェス限を取り逃さない。
 * focus=true は本命を指名し続け、false は未所持を順に指名する。
 */
function runBlockRun(targets, { focus }, maxBlocks = 4) {
  const others = targets - 1;
  // 各状態は質量と「そこへ到達した質量が積んだ文字の総和」を持つ。
  // 文字を状態キーに含めないので状態数は増えず、条件付き期待値も取り出せる。
  let states = new Map([['0:0:0', { mass: 1, letters: 0 }]]);
  const blocks = [];
  let pulls = 0;
  let live = 1;

  for (let block = 1; block <= maxBlocks; block += 1) {
    for (let step = 0; step < EXCHANGE_INTERVAL; step += 1) {
      const next = new Map();
      const add = (key, mass, letters) => {
        const cell = next.get(key) ?? { mass: 0, letters: 0 };
        cell.mass += mass;
        cell.letters += letters;
        next.set(key, cell);
      };
      for (const [key, cell] of states) {
        // main=本命の入手数 / pu=指名か交換で得たその他 / spook=すり抜けだけで得たその他
        const [main, pu, spook] = key.split(':').map(Number);
        const { mass, letters } = cell;
        pulls += mass;
        const ownedOthers = pu + spook;
        const missing = others - ownedOthers;
        const nameMain = focus || main === 0 || missing === 0;
        const freshRate = SPOOK_EACH_RATE * (nameMain ? missing : Math.max(0, missing - 1));
        const mainDupRate = nameMain || main === 0 ? 0 : SPOOK_EACH_RATE;
        const otherDupRate = SPOOK_EACH_RATE * ownedOthers;
        const dupRate = mainDupRate + otherDupRate;
        const miss = 1 - NORMAL_PU_RATE - freshRate - dupRate;
        // 分岐したぶんの文字は、元の状態が積んでいた文字を確率で按分して引き継ぐ。
        const carry = (rate) => (letters * rate) + (mass * rate * 0);
        if (nameMain) {
          const gain = main === 0 ? BONUS_LETTERS : PU_DUPLICATE_LETTERS;
          add(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${pu}:${spook}`,
            mass * NORMAL_PU_RATE, carry(NORMAL_PU_RATE) + mass * NORMAL_PU_RATE * gain);
        } else {
          add(`${main}:${pu + 1}:${spook}`,
            mass * NORMAL_PU_RATE, carry(NORMAL_PU_RATE) + mass * NORMAL_PU_RATE * BONUS_LETTERS);
        }
        if (freshRate > 0) add(`${main}:${pu}:${spook + 1}`, mass * freshRate, carry(freshRate));
        if (dupRate > 0) {
          add(key, mass * dupRate, carry(dupRate) + mass * dupRate * SPOOK_DUPLICATE_LETTERS);
        }
        if (miss > 0) add(key, mass * miss, carry(miss));
      }
      states = next;
    }

    const exchanged = new Map();
    const add2 = (key, mass, letters) => {
      const cell = exchanged.get(key) ?? { mass: 0, letters: 0 };
      cell.mass += mass;
      cell.letters += letters;
      exchanged.set(key, cell);
    };
    for (const [key, cell] of states) {
      const [main, pu, spook] = key.split(':').map(Number);
      const { mass, letters } = cell;
      const missing = others - pu - spook;
      // 交換はイロハ以外の未所持を優先する。イロハは指名で掘っている最中なので、
      // 交換で取るのは彼女が最後まで出なかったときの保険に回す。
      if (missing > 0) add2(`${main}:${pu + 1}:${spook}`, mass, letters + mass * BONUS_LETTERS);
      else if (main === 0) add2(`1:${pu}:${spook}`, mass, letters + mass * BONUS_LETTERS);
      else if (spook > 0) {
        // すり抜けで得た生徒は初回ボーナスが残っているので、引き取ると200文字になる。
        add2(`${main}:${pu + 1}:${spook - 1}`, mass, letters + mass * (PU_DUPLICATE_LETTERS + BONUS_LETTERS));
      } else {
        add2(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${pu}:${spook}`, mass, letters + mass * PU_DUPLICATE_LETTERS);
      }
    }
    states = exchanged;

    const keep = new Map();
    let finished = 0;
    let finishedLetters = 0;
    for (const [key, cell] of states) {
      const [main, pu, spook] = key.split(':').map(Number);
      if (main >= 1 && pu + spook >= others) { finished += cell.mass; finishedLetters += cell.letters; }
      else keep.set(key, cell);
    }
    blocks.push({
      pulls: block * EXCHANGE_INTERVAL,
      stopHere: finished,
      lettersHere: finished > 0 ? finishedLetters / finished : 0,
    });
    states = keep;
    live -= finished;
    if (live < 1e-12) break;
  }

  const stopAt = Object.fromEntries(blocks.map((b) => [b.pulls, b.stopHere]));
  const letters = blocks.reduce((sum, b) => sum + b.stopHere * b.lettersHere, 0);
  return { blocks, stopAt, unfinished: Math.max(0, live), letters, pulls };
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

  // 呼出チャージで素体だけそろえて撤退する運用。すり抜けの得失を測る。
  const retreat = Object.fromEntries(TARGETS.map((target) => [target, {
    withSpook: runRetreat(target, { allowSpook: true }),
    withoutSpook: runRetreat(target, { allowSpook: false }),
  }]));

  // 呼出ポイントで本命に集中したとき、交換枠の流し先で結果がどう変わるか。
  const exchangePlans = [
    { id: 'subThenMain', plan: ['sub', 'main'] },
    { id: 'subThenVeteran', plan: ['sub', 'veteran'] },
  ];
  const focusExchange = Object.fromEntries([200, 400].map((limit) => [
    limit,
    Object.fromEntries(exchangePlans.map(({ id, plan }) => [id, runFocusExchange(limit, plan)])),
  ]));

  // そろったら止める前提での、200連ブロック単位の進め方。
  const blockRun = Object.fromEntries([2, 3, 4].map((targets) => [targets, {
    focus: runBlockRun(targets, { focus: true }),
    sequential: runBlockRun(targets, { focus: false }),
  }]));

  // 2PU・200連時点の分岐。旧仕様で交換枠が余るのはどれくらいかを見る。
  const twoPuBranch = (() => {
    const iroha = 1 - ((1 - NORMAL_PU_RATE) ** EXCHANGE_INTERVAL);
    const ibuki = 1 - ((1 - SPOOK_EACH_RATE) ** EXCHANGE_INTERVAL);
    return {
      bothArrived: iroha * ibuki,
      exchangeForPartner: iroha * (1 - ibuki),
      exchangeForMain: (1 - iroha) * ibuki,
      overtime: (1 - iroha) * (1 - ibuki),
    };
  })();

  // 石そのものの取り分。フェス限は星3が倍なので、同じ連数でも欠片が多く残る。
  const shardYield = (() => {
    const normal = SHARDS_PER_TEN_NORMAL / 10;
    const festival = SHARDS_PER_TEN_FESTIVAL / 10;
    const perBlock = (rate) => rate * EXCHANGE_INTERVAL;
    return {
      perPullNormal: normal,
      perPullFestival: festival,
      perBlockNormal: perBlock(normal),
      perBlockFestival: perBlock(festival),
      blockGain: perBlock(festival) - perBlock(normal),
      blockGainLetters: Math.round((perBlock(festival) - perBlock(normal)) * USEFUL_SHARD_RATIO / SHARD_TAIL_RATE),
      usefulRatio: USEFUL_SHARD_RATIO,
      bankGain: (festival - normal) * BANK_PULLS,
      bankGainLetters: Math.round((festival - normal) * BANK_PULLS * USEFUL_SHARD_RATIO / SHARD_TAIL_RATE),
    };
  })();

  // チャージ99を次の募集へ持ち越す仕込みの台帳。
  // 指名生徒を引くとカウンタは0に戻るが、その後の外れ分はまた積み上がる。
  // よって99連を回しても「カウンタ0で終わる」わけではない。
  const banking = (() => {
    const q = 1 - NORMAL_PU_RATE;
    // カウンタcから指名生徒を1体確保するまでの期待連数(100連目50%、200連目確定)。
    const expected = (charge) => (1 - q ** (100 - charge)) / NORMAL_PU_RATE
      + 0.5 * q ** (99 - charge) * (1 - q ** 100) / NORMAL_PU_RATE;
    const fromZero = expected(0);
    const fromBank = expected(BANK_PULLS);

    // 99連終了時のカウンタKは「末尾の外れ連続長」。K=t は 99-t 連目がヒットし以降t連が全外れ。
    let expectedSaving = 0;
    let expectedCharge = 0;
    for (let tail = 0; tail <= BANK_PULLS - 1; tail += 1) {
      const mass = NORMAL_PU_RATE * (q ** tail);
      expectedSaving += mass * (fromZero - expected(tail));
      expectedCharge += mass * tail;
    }
    const survival = q ** BANK_PULLS;          // 一度も引かずカウンタ99で終わる確率
    expectedSaving += survival * (fromZero - fromBank);
    expectedCharge += survival * BANK_PULLS;

    // 指名生徒が出た時点で止める運用。天井前なので純コストは (1-q^99)*E(0) に一致する。
    const stopOnHitCost = (1 - survival) * fromZero;
    const hits = NORMAL_PU_RATE * BANK_PULLS;  // 99連での期待獲得数
    const letters = (PU_DUPLICATE_LETTERS + BONUS_LETTERS) * (1 - survival)
      + PU_DUPLICATE_LETTERS * (hits - (1 - survival));
    const poolHits = SPOOK_TOTAL_RATE * BANK_PULLS;
    const otherStar3Festival = FES_STAR3_RATE - NORMAL_PU_RATE - SPOOK_TOTAL_RATE;
    const limitedOtherRate = LIMITED_STAR3_RATE - (NORMAL_PU_RATE * 2);
    const carryPulls = BANK_PULLS - expectedSaving;

    return {
      bankPulls: BANK_PULLS,
      expectedPullsPlain: fromZero,
      expectedPullsBanked: fromBank,
      savedPulls: fromZero - fromBank,
      expectedSaving,
      expectedCharge,
      survivalToBank: survival,
      hitChance: 1 - survival,
      carryPulls,
      stopOnHitCost,
      expectedHits: hits,
      lettersFromNamed: letters,
      poolHits,
      lettersFromPool: poolHits * SPOOK_DUPLICATE_LETTERS,
      shardsFromPool: poolHits * DUPLICATE_SHARDS,
      otherStar3Festival,
      limitedOtherRate,
      star3Gained: otherStar3Festival * BANK_PULLS,
      star3Forgone: limitedOtherRate * expectedSaving,
      guaranteedWithinBanked: 200 - BANK_PULLS,
    };
  })();
  // 暴発した側だけの条件付き平均短縮。全体から非暴発枝を引いて求める。
  banking.savingWhenHit = (banking.expectedSaving - banking.survivalToBank * banking.savedPulls)
    / banking.hitChance;
  // 支出を文字へ直すレート。指名を追う効率そのもの。
  banking.lettersPerPull = (PU_DUPLICATE_LETTERS + BONUS_LETTERS) / banking.expectedPullsPlain;
  banking.costLetters = banking.carryPulls * banking.lettersPerPull;
  banking.star3Net = banking.star3Gained - banking.star3Forgone;
  banking.lettersTotal = banking.lettersFromNamed + banking.lettersFromPool;
  banking.twoSetPlain = banking.expectedPullsPlain * 2;
  banking.twoSetBanked = banking.expectedPullsBanked + banking.expectedPullsPlain;
  banking.twoSetSaved = banking.twoSetPlain - banking.twoSetBanked;

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
    retreat,
    focusExchange,
    blockRun,
    twoPuBranch,
    shardYield,
    banking,
    audit: { maxMassError },
  };

  if (maxMassError > 1e-12) throw new Error(`確率質量の保存に失敗: ${maxMassError}`);
  return result;
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/** 呼出ポイントが交換できる区切り。ここが意思決定の分岐点になる。 */
const TABLE_PULLS = { 2: [200, 400], 3: [200, 400, 600], 4: [400, 600, 800] };


const PU_TAB_NAMES = { 2: '2PU', 3: '3PU', 4: '4PU' };
const PU_TAB_LEAD = {
  2: '制服ネル・リオ所持済みのベテラン先生。新規2名（水着イロハ・水着イブキ）狙い。',
  3: '4周年以降開始、制服ネルかリオの片方をすり抜け確保済み。残り3名狙い。',
  4: '復刻の制服ネル・リオも未所持の新規先生。対象4名すべて狙い。',
};

/** 2PU専用。呼出ポイントの機械的な流れと、200連時点の分岐だけを示す。 */
function pointBlock(result) {
  const b = result.twoPuBranch;
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  return `<h3>呼出ポイント</h3><p>機械的に水着イロハを200連指名。200連時点の結果だけで分岐。</p><table><colgroup><col style="width:40%"><col style="width:16%"><col style="width:44%"></colgroup><thead><tr><th>200連時点</th><th>確率</th><th>動き</th></tr></thead><tbody><tr><th>イロハ自引き＋イブキすり抜け</th><td data-label="確率">${p(b.bothArrived)}</td><td data-label="動き">完了。交換枠は余り、どちらかの重複100文字</td></tr><tr><th>イロハ自引きのみ</th><td data-label="確率" class="best">${p(b.exchangeForPartner)}</td><td data-label="動き">交換でイブキ確保、完了</td></tr><tr><th>イブキすり抜けのみ</th><td data-label="確率">${p(b.exchangeForMain)}</td><td data-label="動き">交換でイロハ確保、完了</td></tr><tr><th>どちらも無し</th><td data-label="確率">${p(b.overtime)}</td><td data-label="動き">地獄の残業へ。イロハを引き続け、400連時点で不足分を交換（最悪イロハ・イブキを各1体交換）</td></tr></tbody></table><p class="note">残業中にイロハが出ても引き止めなし、400連まで回して不足分を交換。余った交換枠はイロハかイブキの重複100文字に充て、他生徒は登場させない。</p>
<h3>水着イブキへのPU切替はナシ</h3><p>イロハを引けた後にPU対象をイブキへ切り替えるプラン：期待文字が${Math.round(result.blockRun[2].focus.letters)}文字→${Math.round(result.blockRun[2].sequential.letters)}文字に減るだけで消費は同一。<b>ありえない。</b></p><p class="note">イロハ確保後に固有3の制服ネルへ切り替えれば期待+56文字だが、旧仕様は今後戻らないため、ニッチパターンとして対象外。</p>`;
}


const PU_CLOSING_SOURCE = {
  2: '<p class="note">2PUでは進め方を変えても降りる時点は動きません。<b>約8割が200連で解放され、残る2割が400連の残業に回ります</b>。イロハに集中したほうが重複ぶんで8文字だけ多く残りますが、素体をそろえる速さは同じです。期待文字はどちらも300前後で、イブキが素体確保で十分な性能ならこれで目的は果たせています。イブキにも固有2が要るなら<b>340文字には遠く届かず</b>、このガチャだけでは完結しません。</p>',
  3: '<p class="note">3PUになると進め方で結果が割れます。引けたら次の生徒へ移れば<b>200連で降りられる確率が50.6%</b>まで上がり、期待消費は36,640石。イロハに集中すると200連での解放は25.7%に半減し、期待消費は44,477石へ膨らみます。そのかわり集中したほうが<b>76文字多く</b>持ち帰ります。</p><p class="note">7,837石を積んで76文字を買う取引だと言い換えられます。アタッカーの固有2を急ぐなら悪くありませんが、素体をそろえて次の募集へ石を残したいなら、素直に引けた順で乗り換えるほうが安く上がります。<b>この判断を先生が持てること自体が、呼出ポイントにしかない性質です。</b></p>',
  4: '<p class="note">4名を全部そろえるとなると、引けた順に乗り換えても<b>200連で降りられるのは26.6%</b>にとどまり、6割が400連まで、1割強は600連まで続きます。イロハに集中した場合は200連での解放が6.6%まで落ち、期待消費は58,633石。乗り換えとの差は13,886石にひらきます。</p><p class="note">ここまで来ると、集中か乗り換えかという話より<b>そもそも簡単には降りられない</b>ことのほうが重くのしかかります。新規の先生が4名を狙うのは、どちらの仕様でもそれだけ重い挑戦です。</p>',
};

// 結論表の直下に置く説明。2PUは残業の重さを、3PU以上は表の読み方を示す。
const CONCLUSION_NOTE = {
  2: '<p class="note">呼出ポイントは200連単位でしか降りられない。<b>約8割が200連で解放、残る2割は400連目開始という地獄の残業。</b></p>',
  3: '<p class="note">呼出ポイントは200連単位でしか降りられないため、200連で終えた場合と残業を分けて表記。呼出チャージは区切りなし、平均のみ。</p>' + PU_CLOSING_SOURCE[3],
  4: '<p class="note">呼出ポイントは200連単位でしか降りられないため、200連で終えた場合と残業を分けて表記。呼出チャージは区切りなし、平均のみ。</p>' + PU_CLOSING_SOURCE[4],
};

// 呼出チャージ節の表下に置く、狙い順の説明。
const RETREAT_NOTE = {
  2: '交換がなく、機械的に水着イロハ→水着イブキの順に指名して引き当てる。途中でイブキがすり抜けたら嬉しいが、固有2必須なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
  3: '交換がなく、機械的に水着イロハ→水着イブキ→制服ネルの順に指名して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
  4: '交換がなく、機械的に水着イロハ→水着イブキ→制服ネル→リオの順に指名して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
};


function retreatSection(result) {
  const tabs = [...TARGETS.map((target) => `<button type="button" role="tab" id="tab-${target}pu" aria-controls="pu-panel" aria-selected="${target === 2}" tabindex="${target === 2 ? 0 : -1}" data-pu="${target}">${PU_TAB_NAMES[target]}</button>`),
    '<button type="button" role="tab" id="tab-bankpu" aria-controls="pu-panel" aria-selected="false" tabindex="-1" data-pu="bank">99連</button>'].join('');
  const panels = TARGETS.map((target) => {
    const withSpook = result.retreat[target].withSpook;
    const without = result.retreat[target].withoutSpook;
    const savedPulls = without.expectedPulls - withSpook.expectedPulls;
    const lostLetters = without.letters - withSpook.letters;
    const charge = result.scenarios.charge[target].expectedPullsToAllBase;
    const point = result.scenarios.point[target].expectedPullsToAllBase;
    return `<div data-pu-panel="${target}"${target === 2 ? '' : ' hidden'}><p>${PU_TAB_LEAD[target]}</p>
<h3>結論</h3>${verdictLines(result, target, withSpook)}<table><colgroup><col style="width:30%"><col style="width:16%"><col style="width:16%"><col style="width:19%"><col style="width:19%"></colgroup><thead><tr><th>仕様と進め方</th><th>確率</th><th>連数</th><th>石</th><th>獲得文字</th></tr></thead><tbody>${outcomeRows(result, target).join('')}</tbody></table>${CONCLUSION_NOTE[target]}
<h3>呼出チャージ</h3><table><colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup><thead><tr><th>そろえ方</th><th>期待募集回数</th><th>獲得文字</th></tr></thead><tbody><tr><th>${target}PU期待値</th><td data-label="期待募集回数">${without.expectedPulls.toFixed(1)}連</td><td data-label="獲得文字" class="best">${Math.round(without.letters)}文字</td></tr><tr><th>すり抜け込</th><td data-label="期待募集回数" class="best">${withSpook.expectedPulls.toFixed(1)}連</td><td data-label="獲得文字">${Math.round(withSpook.letters)}文字</td></tr><tr><th>差</th><td data-label="期待募集回数">−${savedPulls.toFixed(1)}連</td><td data-label="獲得文字">−${Math.round(lostLetters)}文字</td></tr><tr><th>すり抜け率</th><td colspan="2" data-label="すり抜け率">${(withSpook.finishedViaSpook * 100).toFixed(2)}%</td></tr></tbody></table><p class="note">${RETREAT_NOTE[target]}</p>

${target === 2 ? pointBlock(result) : ''}</div>`;
  }).join('') + `<div data-pu-panel="bank" hidden><p>呼出チャージは募集種別ごとに引き継ぎ。フェス限で99連止めしておけば、<b>次の限定をチャージ99で開始できる</b>。指名は<b>素体所持・初回ボーナス未受領の生徒</b>（制服ネル等）。引ければ重複100＋ボーナス100の200文字。</p><h3>カウンタは無駄にならない</h3><p>途中で出てもカウンタは<b>積み直し</b>。99連完走時の残カウンタ期待値は${result.banking.expectedCharge.toFixed(0)}、持ち込める短縮は平均<b>${result.banking.expectedSaving.toFixed(1)}連</b>。暴発で台無しにはならない。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>99連を回した結果</th><th>確率</th><th>次の募集での短縮</th></tr></thead><tbody><tr><th>一度も出ずカウンタ99</th><td data-label="確率">${pct(result.banking.survivalToBank)}</td><td data-label="次の募集での短縮" class="best">${result.banking.savedPulls.toFixed(1)}連</td></tr><tr><th>途中で出た（カウンタは積み直し）</th><td data-label="確率">${pct(result.banking.hitChance)}</td><td data-label="次の募集での短縮">平均${result.banking.savingWhenHit.toFixed(1)}連</td></tr><tr><th>ならして</th><td data-label="確率">—</td><td data-label="次の募集での短縮">${result.banking.expectedSaving.toFixed(1)}連</td></tr></tbody></table><h3>収支</h3><p>持ち出しは99連−短縮分の<b>${result.banking.carryPulls.toFixed(1)}連</b>（${stone(result.banking.carryPulls)}石）。指名追いの効率${result.banking.lettersPerPull.toFixed(2)}文字/連で換算して<b>${result.banking.costLetters.toFixed(0)}文字</b>の支出。対する受け取りは以下。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>受け取るもの</th><th>期待</th><th>文字換算</th></tr></thead><tbody><tr><th>指名生徒（初回ボーナス込み）</th><td data-label="期待">${result.banking.expectedHits.toFixed(2)}体</td><td data-label="文字換算" class="best">${result.banking.lettersFromNamed.toFixed(0)}文字</td></tr><tr><th>フェス限9名プール</th><td data-label="期待">${result.banking.poolHits.toFixed(2)}件</td><td data-label="文字換算">${result.banking.lettersFromPool.toFixed(0)}文字＋欠片${result.banking.shardsFromPool.toFixed(0)}</td></tr><tr><th>恒常星3（限定で引いた場合との差）</th><td data-label="期待">+${result.banking.star3Net.toFixed(2)}体</td><td data-label="文字換算">—</td></tr><tr><th>合計</th><td data-label="期待">—</td><td data-label="文字換算" class="best">${result.banking.lettersTotal.toFixed(0)}文字</td></tr></tbody></table><p class="formula">支出 ${result.banking.costLetters.toFixed(0)}文字 ＜ 受け取り ${result.banking.lettersTotal.toFixed(0)}文字 ＋ 星3 ${result.banking.star3Net.toFixed(2)}体 ＋ 欠片 ${result.banking.shardsFromPool.toFixed(0)}</p><p class="note">文字だけで支出を超過。星3と欠片は丸ごと上乗せ。<b>指名生徒の文字を取り切りたい先生には得。</b></p><p class="note">同じ99連ならフェス限期間のほうが欠片約${result.shardYield.bankGain}枚多い。凸に回せる分に割り引けば${result.shardYield.bankGainLetters}文字程度、判断には影響なし。</p><h3>出たら即止め</h3><p class="note">出た後も99連まで回すと効率は約1.1文字/連に半減。<b>出た時点で止めれば</b>持ち出しは${result.banking.stopOnHitCost.toFixed(1)}連、素追いと同効率。</p><h3>向き・不向き</h3><ul class="rules"><li><b>得</b>：指名生徒の文字を取り切りたい先生。素追いと同じ石効率にフェス限すり抜けが上乗せ。外しても次の限定で平均${result.banking.expectedSaving.toFixed(1)}連分返ってくる。</li><li><b>損</b>：文字の受け皿が無い先生。石で欠片と使わない星3を買うだけ。分かれ目は指名生徒1体分の文字に使い道があるか。</li></ul></div>`;
  return `<section class="panel"><h2>狙う人数で選ぶ</h2><p>結論は狙う人数で変わる。該当するタブに、費用から降りどきまでを集約。</p><div class="tabs" role="tablist" aria-label="狙う人数">${tabs}</div><div id="pu-panel" role="tabpanel" aria-labelledby="tab-2pu">${panels}</div></section>`;
}

// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。
// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');

/** 200連ブロックごとの撤退確率。悲惨な残業がどれだけの確率で起きるかを見る。 */
/** 新旧をひとつの表に並べ、呼出ポイントは降りたブロックごとに分けて示す。 */
/** 結論の判定行。旧仕様側の進め方ごとに、浮いた石の掘り返しをぶつけて優位を一意に決める。 */
function verdictLines(result, target, withSpook) {
  const rate = result.banking.lettersPerPull;
  const line = (plan, label) => {
    const saved = plan.pulls - withSpook.expectedPulls;
    const lost = plan.letters - withSpook.letters;
    const recovered = saved * rate;
    const net = recovered - lost;
    return `<p class="verdict">${label}<b>呼出チャージは${stone(saved)}石安くなる代わりに${Math.round(lost)}文字減少。</b>浮いた${saved.toFixed(1)}連を期待値90連の200文字掘りに回すと${Math.round(recovered)}文字相当——差引${net >= 0 ? '+' : '−'}${Math.abs(Math.round(net))}文字で<b>${net >= 0 ? '呼出チャージ' : '呼出ポイント'}優位</b>。</p>`;
  };
  if (target === 2) return line(result.blockRun[2].focus, '');
  return line(result.blockRun[target].focus, '<b>対・イロハ集中</b>｜')
    + line(result.blockRun[target].sequential, '<b>対・引けたら次へ</b>｜');
}

function outcomeRows(result, targets) {
  const charge = result.retreat[targets].withSpook;
  const rows = [`<tr><th>呼出チャージ</th><td data-label="確率">—</td><td data-label="連数">${charge.expectedPulls.toFixed(1)}連</td><td data-label="石">${stone(charge.expectedPulls)}石</td><td data-label="獲得文字">${Math.round(charge.letters)}文字</td></tr>`];
  // 2PUは進め方による差が数文字しかないので、イロハ集中の1系統だけ載せる。
  const plansToShow = targets === 2
    ? [['focus', '呼出ポイント']]
    : [['sequential', '呼出ポイント・引けたら次へ'], ['focus', '呼出ポイント・イロハに集中']];
  for (const [id, label] of plansToShow) {
    const plan = result.blockRun[targets][id];
    plan.blocks.filter((block) => block.stopHere > 0.001).forEach((block, index) => {
      const head = index === 0 ? `<th rowspan="${plan.blocks.filter((b) => b.stopHere > 0.001).length + 1}">${label}</th>` : '';
      rows.push(`<tr>${head}<td data-label="確率">${(block.stopHere * 100).toFixed(1)}%</td><td data-label="連数">${block.pulls}連</td><td data-label="石">${(block.pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP')}石</td><td data-label="獲得文字">${Math.round(block.lettersHere)}文字</td></tr>`);
    });
    rows.push(`<tr><td data-label="確率">ならして</td><td data-label="連数">${plan.pulls.toFixed(1)}連</td><td data-label="石">${stone(plan.pulls)}石</td><td data-label="獲得文字">${Math.round(plan.letters)}文字</td></tr>`);
  }
  return rows;
}

/** 差がある場合だけ有利な側へ印を付ける。到達率は高い方、期待回数は少ない方が有利。 */
function better(value, rival, preferHigh) {
  const wins = preferHigh ? value > rival + 1e-9 : value < rival - 1e-9;
  return wins ? ' class="best"' : '';
}

const FESTIVAL_TAB_JS = "const puTabs=[...document.querySelectorAll('[data-pu]')],puPanels=[...document.querySelectorAll('[data-pu-panel]')];const selectPu=value=>{puTabs.forEach(tab=>{const on=tab.dataset.pu===value;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1});puPanels.forEach(panel=>{panel.hidden=panel.dataset.puPanel!==value});document.getElementById('pu-panel').setAttribute('aria-labelledby','tab-'+value+'pu')};puTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectPu(tab.dataset.pu));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowLeft')next=(index-1+puTabs.length)%puTabs.length;if(event.key==='ArrowRight')next=(index+1)%puTabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=puTabs.length-1;puTabs[next].focus();selectPu(puTabs[next].dataset.pu)})});";

const FESTIVAL_CSS = ':root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e;--series-charge:#14506e;--series-point:#9a6a00;--grid-minor:#e3d9c9;--grid-major:#a99c8e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(1100px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}h1,h2{font-size:17px;font-weight:600;line-height:1.3}h3{font-size:15px;font-weight:700;margin:24px 0 10px;padding:0 0 5px;border-bottom:1px solid var(--border);color:var(--on)}h4{font-size:14px;font-weight:600;margin:16px 0 8px;color:var(--muted)}[data-pu-panel]>p:first-of-type{color:var(--muted);margin-bottom:4px}.hero{padding:16px 0 24px}.header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.hero h1{margin:0}.lead{color:var(--muted);margin:8px 0 0}.repo-link{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-decoration:none}.repo-link:hover{color:var(--link)}.repo-link svg{width:20px;height:20px;flex:none}.panel{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}.panel h2{margin:0 0 12px}.panel p{margin:0 0 12px}.panel p:last-child{margin-bottom:0}.rules{margin:0;padding:0;list-style:none}.rules li{padding:6px 0;border-bottom:1px dashed var(--border);font-size:15px}.rules li:last-child{border-bottom:0}.rules b{color:var(--accent)}.verdict{background:var(--accent-subtle);border-left:4px solid var(--accent);border-radius:0 6px 6px 0;padding:10px 14px;font-size:16px;margin:0 0 12px}.verdict b{color:var(--accent)}.formula{font-variant-numeric:tabular-nums;background:var(--accent-subtle);border-radius:6px;padding:10px 12px;font-size:15px}details summary{cursor:pointer;font-weight:600;font-size:15px;padding:2px 0;color:var(--muted)}details[open] summary{margin-bottom:8px;color:var(--on)}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tabs{display:flex;gap:4px;margin:0 0 12px}.tabs button{flex:1 1 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--muted);font:500 15px/1.2 system-ui,sans-serif;cursor:pointer}.tabs button[aria-selected="true"]{background:var(--accent-subtle);border-color:var(--accent);color:var(--on)}table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}th,td{padding:8px 6px;border-bottom:1px solid var(--border);text-align:right;vertical-align:top}thead th{text-align:center;color:var(--muted);font-size:13px;font-weight:600}tbody th{text-align:left;font-size:14px;white-space:nowrap}tbody th.sub{color:var(--muted);font-weight:500}td b{display:block;font-size:15px;font-weight:600;white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px;line-height:1.3;margin-bottom:4px}td small:last-child{margin-bottom:0}tbody+tbody th,tbody+tbody td{border-top:2px solid var(--grid-major)}b.best{color:var(--link)}b.best:after{content:"\\2009\\25B8";font-size:11px;vertical-align:1px}.best{color:var(--link);font-weight:600}.note{color:var(--muted);font-size:14px;margin:12px 0 0}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}@media(max-width:760px){main{width:min(100% - 16px,1100px);margin:16px auto}.panel{padding:12px 8px}.hero{padding-top:8px}.repo-link span{display:none}th,td{padding:8px 4px}.rules li{font-size:14px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff;--series-charge:#7fdbff;--series-point:#e0a800;--grid-minor:#333;--grid-major:#666}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}.nav{align-items:flex-end;justify-content:space-between}.nav-pages,.language-switch{display:flex;gap:16px}.language-switch{gap:4px;padding:0 0 8px;color:var(--muted);font-size:12px}.language-switch a,.language-switch span{padding:0 4px}.language-switch [aria-current="true"]{color:var(--on);font-weight:700}@media(max-width:700px){table{display:block}colgroup{display:none}thead{display:none}tbody{display:block}tbody+tbody th,tbody+tbody td{border-top:0}tr{display:block;border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin:0 0 8px}tbody th{display:block;border:0;border-bottom:1px solid var(--border);padding:0 0 5px;margin:0 0 5px;text-align:left;font-weight:700;white-space:normal}td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border:0;padding:3px 0;text-align:right}td:before{content:attr(data-label);color:var(--muted);font-size:12px;font-weight:500;text-align:left;flex:0 0 auto}td b,td small{display:inline;white-space:nowrap}td small{margin:0 0 0 4px}}';

const GITHUB_LINK = '<a class="repo-link" href="https://github.com/miyabisun/arona-gacha-calc" aria-label="GitHubリポジトリを開く"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.5 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/></svg><span>miyabisun/arona-gacha-calc</span></a>';


function renderFestivalHtml(result) {
  const rates = result.rates;
  const banking = result.banking;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5フェス限の新旧比較</title><link rel="stylesheet" href="css/festival.css"></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5フェス限の新旧比較</h1>${GITHUB_LINK}</div><p class="lead">フェス限すり抜け確率が高いため、通常の募集と比べて変数が多い。5.5周年のフェス限ガチャの新旧比較検証を机上で行う。</p></header>
<section class="panel"><details><summary>計算に使う前提</summary><ul class="rules"><li>フェス限定募集の星3排出率 <b>${pct(rates.festivalStar3)}</b>。</li><li>指名1名の排出率 <b>${pct(rates.namedPu)}</b>。呼出チャージはチャージ99で50%、199で100%。</li><li>新旧フェス限10名−指名中1名の<b>9名</b>で <b>${pct(rates.spookPoolTotal)}</b> を等分、1名 <b>${pct(rates.spookEach)}</b>。</li><li>残り <b>${pct(rates.otherStar3)}</b> は恒常星3。内訳の記録のみ、計算には不使用。</li><li>初回PUボーナスは<b>指名PU自引きと呼出ポイント交換</b>のみ。すり抜けでは付かない。</li><li>素体なしを優先指名。全員素体済みなら素体持ちを指名してボーナス回収。</li><li>文字と欠片は別勘定。欠片は在庫潤沢な先生が多く、同じ重みでは扱えない。</li><li>欠片の取り分はフェス限10連80枚（平常時50枚）扱い。新旧共通のため比較に影響なし。</li></ul></details></section>
${retreatSection(result)}
<footer>Generated by scripts/festival.js</footer></main>
<script src="js/festival.js" defer></script></body></html>`;
}

/**
 * 英語版。置換は配列順に適用され、後段のパターンは前段適用後の文字列を指す。
 * 長い一文から先に置換し、最後に短い語を置き換える。
 */
const ENGLISH_REPLACEMENTS = [
  ['<html lang="ja">', '<html lang="en">'],
  ['href="css/festival.css"', 'href="../css/festival.css"'],
  ['src="js/festival.js"', 'src="../js/festival.js"'],
  ['<title>5.5フェス限の新旧比較</title>', '<title>5.5th Anniversary Festival Comparison</title>'],
  ['<h1>5.5フェス限の新旧比較</h1>', '<h1>5.5th Anniversary Festival Comparison</h1>'],
  ['aria-label="GitHubリポジトリを開く"', 'aria-label="Open the GitHub repository"'],
  [
    'フェス限すり抜け確率が高いため、通常の募集と比べて変数が多い。5.5周年のフェス限ガチャの新旧比較検証を机上で行う。',
    'Festival spooks are frequent, adding variables normal banners lack. A desk-side check of the 5.5th-anniversary festival banner: old spec versus new.',
  ],
  ['<summary>計算に使う前提</summary>', '<summary>Assumptions</summary>'],
  [
    '<li>文字と欠片は別勘定。欠片は在庫潤沢な先生が多く、同じ重みでは扱えない。</li><li>欠片の取り分はフェス限10連80枚（平常時50枚）扱い。新旧共通のため比較に影響なし。</li>',
    '<li>Eleph and shards are counted separately. Most players sit on a large shard stock, so shards cannot carry the same weight as Eleph.</li>',
  ],
  ['<li>フェス限定募集の星3排出率 <b>6.00%</b>。</li>', '<li>The 3★ rate during festival recruitment is <b>6.00%</b>.</li>'],
  [
    '<li>指名1名の排出率 <b>0.70%</b>。呼出チャージはチャージ99で50%、199で100%。</li>',
    '<li>The student you select appears at <b>0.70%</b>. Under Recruitment Charge, that becomes 50% at charge 99 and 100% at charge 199.</li>',
  ],
  [
    '<li>新旧フェス限10名−指名中1名の<b>9名</b>で <b>0.90%</b> を等分、1名 <b>0.10%</b>。</li>',
    '<li>The <b>9</b> remaining festival students — 10 in total, minus the one you selected — share <b>0.90%</b> equally, giving <b>0.10%</b> each.</li>',
  ],
  [
    '<li>残り <b>4.40%</b> は恒常星3。内訳の記録のみ、計算には不使用。</li>',
    '<li>The remaining <b>4.40%</b> covers permanent 3★ students. It is recorded for completeness but never used in the calculation.</li>',
  ],
  [
    '<li>初回PUボーナスは<b>指名PU自引きと呼出ポイント交換</b>のみ。すり抜けでは付かない。</li>',
    '<li>The first-time pickup bonus is granted only by <b>pulling the student you selected or exchanging Recruitment Points</b>. An off-target pull never grants it.</li>',
  ],
  [
    '<li>素体なしを優先指名。全員素体済みなら素体持ちを指名してボーナス回収。</li>',
    '<li>The strategy always selects a student you do not own yet; once every student is owned, it selects an owned one to collect the remaining bonuses.</li>',
  ],
  ['<h2>狙う人数で選ぶ</h2>', '<h2>Pick your target count</h2>'],
  ['<b>対・イロハ集中</b>｜', '<b>vs staying on Iroha</b> | '],
  ['<b>対・引けたら次へ</b>｜', '<b>vs moving on after each hit</b> | '],

  ['<b>呼出チャージは', '<b>Recruitment Charge saves '],
  ['石安くなる代わりに', ' Pyroxene at the cost of '],
  ['文字減少。</b>浮いた', ' Eleph.</b> Spend the freed '],
  ['連を期待値90連の200文字掘りに回すと', ' pulls on a 200-Eleph chase (expected 90 pulls) and they return about '],
  ['文字相当——差引+', ' Eleph — net +'],
  ['文字相当——差引−', ' Eleph — net −'],
  ['文字で<b>呼出チャージ優位</b>。</p>', ' Eleph: <b>Recruitment Charge wins</b>.</p>'],
  ['文字で<b>呼出ポイント優位</b>。</p>', ' Eleph: <b>Recruitment Points wins</b>.</p>'],

  ['<h3>呼出ポイント</h3>', '<h3>Recruitment Points</h3>'],
  [
    '<p>機械的に水着イロハを200連指名。200連時点の結果だけで分岐。</p>',
    '<p>Select Swimsuit Iroha for 200 pulls, mechanically. The branch depends only on where things stand at pull 200.</p>',
  ],
  ['<th>200連時点</th>', '<th>At pull 200</th>'],
  ['<th>動き</th>', '<th>Action</th>'],
  ['data-label="動き"', 'data-label="Action"'],
  ['<th>イロハ自引き＋イブキすり抜け</th>', '<th>Iroha pulled + Ibuki spooked</th>'],
  ['<th>イロハ自引きのみ</th>', '<th>Iroha pulled only</th>'],
  ['<th>イブキすり抜けのみ</th>', '<th>Ibuki spooked only</th>'],
  ['<th>どちらも無し</th>', '<th>Neither</th>'],
  ['>完了。交換枠は余り、どちらかの重複100文字<', '>Done. Exchange goes spare: 100 Eleph as a duplicate of either<'],
  ['>交換でイブキ確保、完了<', '>Exchange secures Ibuki, done<'],
  ['>交換でイロハ確保、完了<', '>Exchange secures Iroha, done<'],
  ['>地獄の残業へ。イロハを引き続け、400連時点で不足分を交換（最悪イロハ・イブキを各1体交換）<', '>Overtime from hell. Keep pulling Iroha; at 400 exchange whatever is missing (worst case, one Iroha and one Ibuki)<'],
  [
    '<p class="note">残業中にイロハが出ても引き止めなし、400連まで回して不足分を交換。余った交換枠はイロハかイブキの重複100文字に充て、他生徒は登場させない。</p>',
    '<p class="note">An Iroha landing mid-overtime changes nothing: pull to 400 and exchange what is missing. Spare exchanges go to Iroha or Ibuki duplicates at 100 Eleph — no other student enters the story.</p>',
  ],
  ['<h3>水着イブキへのPU切替はナシ</h3>', '<h3>Never switch the pickup to Ibuki</h3>'],
  [
    '<p>イロハを引けた後にPU対象をイブキへ切り替えるプラン：期待文字が',
    '<p>The plan that switches the pickup to Ibuki once Iroha lands: expected Eleph drops from ',
  ],
  ['文字→', ' to '],
  ['文字に減るだけで消費は同一。<b>ありえない。</b></p>', ' at identical cost. <b>Out of the question.</b></p>'],
  [
    '<p class="note">イロハ確保後に固有3の制服ネルへ切り替えれば期待+56文字だが、旧仕様は今後戻らないため、ニッチパターンとして対象外。</p>',
    '<p class="note">Switching to a UE3 Uniform Nel after Iroha would add an expected +56 Eleph, but the old system is never coming back — a niche pattern, out of scope.</p>',
  ],


  ['>呼出ポイント</th>', '>Recruitment Points</th>'],
  [
    '<p class="note">呼出ポイントは200連単位でしか降りられない。<b>約8割が200連で解放、残る2割は400連目開始という地獄の残業。</b></p>',
    '<p class="note">Recruitment Points only lets you leave on a 200-pull boundary. <b>About 80% are released at 200 pulls; the remaining 20% begin pull 401 — overtime from hell.</b></p>',
  ],
  [
    '<p class="note">呼出ポイントは200連単位でしか降りられないため、200連で終えた場合と残業を分けて表記。呼出チャージは区切りなし、平均のみ。</p>',
    '<p class="note">Recruitment Points can only exit on a 200-pull boundary, so finishing there and going into overtime are listed separately; Recruitment Charge has no boundary, so only its average is shown.</p>',
  ],
  ['<h3>呼出チャージ</h3>', '<h3>Recruitment Charge</h3>'],
  ['PU期待値</th>', 'PU expected</th>'],
  ['<th>すり抜け込</th>', '<th>With spooks</th>'],
  ['<th>すり抜け率</th>', '<th>Spook rate</th>'],
  ['data-label="すり抜け率"', 'data-label="Spook rate"'],
  [
    '交換がなく、機械的に水着イロハ→水着イブキの順に指名して引き当てる。途中でイブキがすり抜けたら嬉しいが、固有2必須なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
    'There is no exchange: you select Swimsuit Iroha, then Swimsuit Ibuki, mechanically in order. An off-banner Ibuki along the way is welcome — but if she needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
  ],
  [
    '交換がなく、機械的に水着イロハ→水着イブキ→制服ネルの順に指名して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
    'There is no exchange: you select Swimsuit Iroha, Swimsuit Ibuki, then Uniform Nel, mechanically in order. Off-banner arrivals along the way are welcome — but for a student who needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
  ],
  [
    '交換がなく、機械的に水着イロハ→水着イブキ→制服ネル→リオの順に指名して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
    'There is no exchange: you select Swimsuit Iroha, Swimsuit Ibuki, Uniform Nel, then Rio, mechanically in order. Off-banner arrivals along the way are welcome — but for a student who needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
  ],

  ['<h3>結論</h3>', '<h3>Verdict</h3>'],

  ['<h3>出たら即止め</h3>', '<h3>But stop the moment she arrives</h3>'],
  [
    '<p class="note">同じ99連ならフェス限期間のほうが欠片約',
    '<p class="note">The same 99 pulls inside the festival, where 3★ runs at double, also leave about ',
  ],
  [
    '枚多い。凸に回せる分に割り引けば',
    ' more shards. Discounted to what actually reaches a build that is roughly ',
  ],
  ['文字程度、判断には影響なし。</p>', ' Eleph — not enough to sway the decision.</p>'],

  ['<th>仕様と進め方</th>', '<th>System and approach</th>'],
  ['<th>連数</th>', '<th>Pulls</th>'],
  ['<th>石</th>', '<th>Pyroxene</th>'],
  ['<th>呼出チャージ</th>', '<th>Recruitment Charge</th>'],
  ['呼出ポイント・引けたら次へ', 'Recruitment Points, moving on'],
  ['呼出ポイント・イロハに集中', 'Recruitment Points, staying on Iroha'],
  ['>ならして<', '>Overall<'],
  ['data-label="連数"', 'data-label="Pulls"'],
  ['data-label="石"', 'data-label="Pyroxene"'],

  [
    '<p>結論は狙う人数で変わる。該当するタブに、費用から降りどきまでを集約。</p>',
    '<p>The answer depends on the target count. Each tab holds everything for that count, cost through exit.</p>',
  ],
  ['制服ネル・リオ所持済みのベテラン先生。新規2名（水着イロハ・水着イブキ）狙い。', 'A veteran already holding Uniform Nel and Rio, going after the two new students (Swimsuit Iroha and Swimsuit Ibuki).'],
  ['4周年以降開始、制服ネルかリオの片方をすり抜け確保済み。残り3名狙い。', 'A player who started after the 4th anniversary and picked up Nel or Rio off-banner, going after the other three.'],
  ['復刻の制服ネル・リオも未所持の新規先生。対象4名すべて狙い。', 'A brand-new player who owns neither of the rerun pair, going after all four featured students.'],
  ['<th>そろえ方</th>', '<th>How they arrive</th>'],
  ['<th>期待募集回数</th>', '<th>Expected pulls</th>'],
  ['<th>獲得文字</th>', '<th>Eleph earned</th>'],
  ['aria-label="狙う人数"', 'aria-label="Number of students targeted"'],
  ['石</td>', ' Pyroxene</td>'],
  ['連</td>', ' pulls</td>'],
  ['文字</td>', ' Eleph</td>'],
  ['data-pu="bank">99連</button>', 'data-pu="bank">Banking</button>'],
  ['連</b>（', ' pulls</b> ('],
  [
    '<p>呼出チャージは募集種別ごとに引き継ぎ。フェス限で99連止めしておけば、<b>次の限定をチャージ99で開始できる</b>。指名は<b>素体所持・初回ボーナス未受領の生徒</b>（制服ネル等）。引ければ重複100＋ボーナス100の200文字。</p>',
    '<p>Recruitment Charge carries over within a banner category, so stopping at 99 pulls on the festival banner means <b>the next limited banner opens at charge 99</b>. The student you select here is <b>one you already own whose first-time bonus is still unspent</b> — Uniform Nel, for instance. Hitting her pays 100 Eleph for the duplicate plus the 100 Eleph bonus: 200 in one go.</p>',
  ],
  ['<h3>カウンタは無駄にならない</h3>', '<h3>The counter is never wasted</h3>'],
  [
    '<p>途中で出てもカウンタは<b>積み直し</b>。99連完走時の残カウンタ期待値は',
    '<p>Hitting the selected student inside those 99 pulls resets the counter to 0, but <b>every miss after that starts stacking again</b>. The counter left in hand once 99 pulls are done averages ',
  ],
  ['、持ち込める短縮は平均<b>', ', and the shortening carried into the next banner averages <b>'],
  ['連</b>。暴発で台無しにはならない。</p>', ' pulls</b>. An early hit does not throw the plan away.</p>'],
  ['<th>99連を回した結果</th>', '<th>After 99 pulls</th>'],
  ['<th>確率</th>', '<th>Chance</th>'],
  ['<th>次の募集での短縮</th>', '<th>Shortening carried</th>'],
  ['<th>一度も出ずカウンタ99</th>', '<th>No hit, counter at 99</th>'],
  ['<th>途中で出た（カウンタは積み直し）</th>', '<th>Hit along the way (counter rebuilt)</th>'],
  ['data-label="確率"', 'data-label="Chance"'],
  ['data-label="次の募集での短縮"', 'data-label="Shortening carried"'],
  ['">平均', '">avg '],
  ['<h3>収支</h3>', '<h3>The ledger</h3>'],
  ['<p>持ち出しは99連−短縮分の<b>', '<p>Netting the shortening out of 99 pulls leaves an outlay of <b>'],
  ['石）。指名追いの効率', ' Pyroxene). Chasing the selected student runs at '],
  ['文字/連で換算して<b>', ' Eleph per pull, so in Eleph that is <b>'],
  ['文字</b>の支出。対する受け取りは以下。</p>', ' Eleph</b> spent. Here is what comes back.</p>'],
  ['<th>受け取るもの</th>', '<th>Received</th>'],
  ['<th>期待</th>', '<th>Expected</th>'],
  ['<th>文字換算</th>', '<th>In Eleph</th>'],
  ['<th>指名生徒（初回ボーナス込み）</th>', '<th>Selected student (bonus included)</th>'],
  ['<th>フェス限9名プール</th>', '<th>The nine-student festival pool</th>'],
  ['<th>恒常星3（限定で引いた場合との差）</th>', '<th>Permanent 3★ (net of the limited banner)</th>'],
  ['<th>合計</th>', '<th>Total</th>'],
  ['data-label="期待"', 'data-label="Expected"'],
  ['data-label="文字換算"', 'data-label="In Eleph"'],
  ['体</td>', '</td>'],
  ['件</td>', '</td>'],
  ['文字＋欠片', ' Eleph + '],
  ['<p class="formula">支出 ', '<p class="formula">Spent '],
  ['文字 ＜ 受け取り ', ' Eleph < received '],
  ['文字 ＋ 星3 ', ' Eleph + '],
  ['体 ＋ 欠片 ', ' 3★ + '],
  [
    '<p class="note">文字だけで支出を超過。星3と欠片は丸ごと上乗せ。<b>指名生徒の文字を取り切りたい先生には得。</b></p>',
    '<p class="note">Eleph alone already clears the bar, with the 3★ students and shards stacked on top. <b>For anyone still collecting Eleph on the selected student, this plan pays.</b></p>',
  ],
  [
    '<p class="note">出た後も99連まで回すと効率は約1.1文字/連に半減。<b>出た時点で止めれば</b>持ち出しは',
    '<p class="note">Carrying on to 99 pulls after the hit drops the efficiency of those extra pulls to about 1.1 Eleph each. <b>Stop when she lands</b> and the outlay settles at exactly ',
  ],
  ['連、素追いと同効率。</p>', ' pulls — the same efficiency as chasing her outright.</p>'],
  ['<h3>向き・不向き</h3>', '<h3>Who this suits</h3>'],
  [
    '<li><b>得</b>：指名生徒の文字を取り切りたい先生。素追いと同じ石効率にフェス限すり抜けが上乗せ。外しても次の限定で平均',
    '<li><b>Worth it</b> if you still want Eleph on the selected student. The Pyroxene efficiency matches chasing her outright, with festival off-target pulls added on top. Even a miss returns an average of ',
  ],
  ['連分返ってくる。</li>', ' pulls on the next limited banner.</li>'],
  [
    '<li><b>損</b>：文字の受け皿が無い先生。石で欠片と使わない星3を買うだけ。分かれ目は指名生徒1体分の文字に使い道があるか。</li>',
    '<li><b>Not worth it</b> if there is nowhere left to spend Eleph. You are buying shards and 3★ students you will never build. The line is simply whether one student\'s worth of Eleph still has a use.</li>',
  ],
  [
    '<p class="note">3PUになると進め方で結果が割れます。引けたら次の生徒へ移れば<b>200連で降りられる確率が50.6%</b>まで上がり、期待消費は36,640石。イロハに集中すると200連での解放は25.7%に半減し、期待消費は44,477石へ膨らみます。そのかわり集中したほうが<b>76文字多く</b>持ち帰ります。</p>',
    '<p class="note">At three students the approaches split apart. Moving on after each hit raises the chance of stopping at 200 pulls to <b>50.6%</b> and costs 36,640 Pyroxene on average. Staying on Iroha halves that release rate to 25.7% and pushes the cost to 44,477 Pyroxene — but carries away <b>76 more Eleph</b>.</p>',
  ],
  [
    '<p class="note">7,837石を積んで76文字を買う取引だと言い換えられます。アタッカーの固有2を急ぐなら悪くありませんが、素体をそろえて次の募集へ石を残したいなら、素直に引けた順で乗り換えるほうが安く上がります。<b>この判断を先生が持てること自体が、呼出ポイントにしかない性質です。</b></p>',
    '<p class="note">Put another way, it buys 76 Eleph for 7,837 Pyroxene. That is a fair trade if an attacker needs UE2 soon, but if the goal is to own everyone and carry Pyroxene into the next banner, switching as each student lands is cheaper. <b>Having that call to make at all belongs to Recruitment Points alone.</b></p>',
  ],
  [
    '<p class="note">4名を全部そろえるとなると、引けた順に乗り換えても<b>200連で降りられるのは26.6%</b>にとどまり、6割が400連まで、1割強は600連まで続きます。イロハに集中した場合は200連での解放が6.6%まで落ち、期待消費は58,633石。乗り換えとの差は13,886石にひらきます。</p>',
    '<p class="note">Going after all four, even switching as each one lands leaves you <b>only a 26.6% chance of stopping at 200 pulls</b>; six in ten run to 400 and better than one in ten to 600. Staying on Iroha drops that release rate to 6.6% and costs 58,633 Pyroxene on average — 13,886 more than switching.</p>',
  ],
  [
    '<p class="note">ここまで来ると、集中か乗り換えかという話より<b>そもそも簡単には降りられない</b>ことのほうが重くのしかかります。新規の先生が4名を狙うのは、どちらの仕様でもそれだけ重い挑戦です。</p>',
    '<p class="note">At this scale the choice between focusing and switching matters less than the plain fact that <b>walking away early is barely an option</b>. Going after four featured students is a heavy commitment under either system.</p>',
  ],
  ['data-label="期待募集回数"', 'data-label="Expected pulls"'],
  ['data-label="獲得文字"', 'data-label="Eleph earned"'],
  ['<th>差</th>', '<th>Gap</th>'],
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
  const thinGroup = (group) => Object.fromEntries(Object.entries(group).map(([id, byKey]) => [
    id,
    Object.fromEntries(Object.entries(byKey).map(([key, row]) => [
      key,
      Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Array.isArray(value) ? thin(value) : value])),
    ])),
  ]));
  return {
    ...result,
    metadata: { ...result.metadata, curveSampleStep: step },
    scenarios: thinGroup(result.scenarios),
  };
}

function main() {
  const started = process.hrtime.bigint();
  const result = calculateFestival();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'festival-results.json'), `${JSON.stringify(thinForJson(result), null, 2)}\n`);
  fs.mkdirSync(path.join(OUTPUT_DIR, 'en'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, 'css'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, 'js'), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'css', 'festival.css'), `${FESTIVAL_CSS}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'js', 'festival.js'), `${FESTIVAL_TAB_JS}\n`);
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
