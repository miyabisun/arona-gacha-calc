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
// 1名を狙い続ける戦略の検討用。今回のPU対象は4名で、本命の凸は固有2を目標に置く。
const FOCUS_TARGETS = 4;
const FOCUS_HIT_CAP = 6;
const FOCUS_MAX_PULLS = 600;
const UE2_LETTERS = 340;
const PYROXENE_PER_PULL = 120;
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
 * 1名を狙い続ける戦略と、未所持を順に埋める戦略の比較。
 * 対象は4名。ownedAtStart は募集開始時点で既に持っている人数。
 * focus=true は本命を指名し続け、他は交換とすり抜けに任せる。
 */
function runFocusStrategy(ownedAtStart, { useCharge, useExchange, focus }, maxPulls = FOCUS_MAX_PULLS) {
  let states = new Map([[`0:${ownedAtStart}:0`, 1]]);
  const reachedUe2 = Array(maxPulls + 1).fill(0);
  const otherOwned = Array(maxPulls + 1).fill(0);
  const focusLetters = Array(maxPulls + 1).fill(0);

  for (let pull = 1; pull <= maxPulls; pull += 1) {
    const next = new Map();
    const add = (key, mass) => next.set(key, (next.get(key) ?? 0) + mass);
    for (const [key, mass] of states) {
      const [hits, others, charge] = key.split(':').map(Number);
      const othersLeft = (FOCUS_TARGETS - 1) - others;
      // 集中なら常に本命。分散でも本命が未所持、または他に取る相手がいなければ本命を指名。
      const namingFocus = focus || hits === 0 || othersLeft === 0;
      const hit = useCharge ? chargeHitRate(charge) : NORMAL_PU_RATE;
      const residual = useCharge ? chargeResidual(charge) : 1;
      const free = namingFocus ? othersLeft : Math.max(0, othersLeft - 1);
      const spook = residual * free * SPOOK_EACH_RATE;
      const miss = 1 - hit - spook;
      const nextCharge = useCharge ? charge + 1 : 0;

      if (hit > 0) {
        if (namingFocus) add(`${Math.min(hits + 1, FOCUS_HIT_CAP)}:${others}:0`, mass * hit);
        else add(`${hits}:${Math.min(others + 1, FOCUS_TARGETS - 1)}:0`, mass * hit);
      }
      if (spook > 0) add(`${hits}:${Math.min(others + 1, FOCUS_TARGETS - 1)}:${nextCharge}`, mass * spook);
      if (miss > 0) add(`${hits}:${others}:${nextCharge}`, mass * miss);
    }
    states = next;

    if (useExchange && pull % EXCHANGE_INTERVAL === 0) {
      const exchanged = new Map();
      const add2 = (key, mass) => exchanged.set(key, (exchanged.get(key) ?? 0) + mass);
      for (const [key, mass] of states) {
        const [hits, others, charge] = key.split(':').map(Number);
        // 交換は未所持を優先。全員そろっていれば本命へ回して文字を積む。
        if (others < FOCUS_TARGETS - 1) add2(`${hits}:${others + 1}:${charge}`, mass);
        else add2(`${Math.min(hits + 1, FOCUS_HIT_CAP)}:${others}:${charge}`, mass);
      }
      states = exchanged;
    }

    for (const [key, mass] of states) {
      const [hits, others] = key.split(':').map(Number);
      const letters = effectiveLetters(hits);
      if (letters >= UE2_LETTERS) reachedUe2[pull] += mass;
      otherOwned[pull] += mass * others;
      focusLetters[pull] += mass * letters;
    }
  }
  return { reachedUe2, otherOwned, focusLetters };
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
  let states = new Map([['0:0:0', 1]]);
  const stopAt = {};
  const lettersAt = {};
  let letters = 0;
  let pulls = 0;
  let live = 1;

  for (let block = 1; block <= maxBlocks; block += 1) {
    for (let step = 0; step < EXCHANGE_INTERVAL; step += 1) {
      const next = new Map();
      const add = (key, mass) => next.set(key, (next.get(key) ?? 0) + mass);
      for (const [key, mass] of states) {
        // main=本命の入手数 / pu=指名か交換で得たその他 / spook=すり抜けだけで得たその他
        const [main, pu, spook] = key.split(':').map(Number);
        pulls += mass;
        const ownedOthers = pu + spook;
        const missing = others - ownedOthers;
        const nameMain = focus || main === 0 || missing === 0;
        // すり抜けは指名していない対象生徒すべてに起きる。未所持なら素体、既所持なら重複30文字。
        const freshRate = SPOOK_EACH_RATE * (nameMain ? missing : Math.max(0, missing - 1));
        // 本命を指名していないあいだは、本命自身もすり抜けで重なりうる（100文字ではなく30文字）。
        const mainDupRate = nameMain || main === 0 ? 0 : SPOOK_EACH_RATE;
        const otherDupRate = SPOOK_EACH_RATE * ownedOthers;
        const spookRate = freshRate + mainDupRate + otherDupRate;
        const miss = 1 - NORMAL_PU_RATE - spookRate;
        if (nameMain) {
          letters += mass * NORMAL_PU_RATE * (main === 0 ? BONUS_LETTERS : PU_DUPLICATE_LETTERS);
          add(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${pu}:${spook}`, mass * NORMAL_PU_RATE);
        } else {
          letters += mass * NORMAL_PU_RATE * BONUS_LETTERS;
          add(`${main}:${pu + 1}:${spook}`, mass * NORMAL_PU_RATE);
        }
        if (freshRate > 0) add(`${main}:${pu}:${spook + 1}`, mass * freshRate);
        // 重複ぶんは状態を動かさず、文字だけ積む。
        letters += mass * (mainDupRate + otherDupRate) * SPOOK_DUPLICATE_LETTERS;
        add(key, mass * (miss + mainDupRate + otherDupRate));
      }
      states = next;
    }

    const exchanged = new Map();
    const add2 = (key, mass) => exchanged.set(key, (exchanged.get(key) ?? 0) + mass);
    for (const [key, mass] of states) {
      const [main, pu, spook] = key.split(':').map(Number);
      const missing = others - pu - spook;
      if (main === 0) { letters += mass * BONUS_LETTERS; add2(`1:${pu}:${spook}`, mass); }
      else if (missing > 0) { letters += mass * BONUS_LETTERS; add2(`${main}:${pu + 1}:${spook}`, mass); }
      else if (spook > 0) {
        // すり抜けで得た生徒は初回ボーナスが残っているので、引き取ると200文字になる。
        letters += mass * (PU_DUPLICATE_LETTERS + BONUS_LETTERS);
        add2(`${main}:${pu + 1}:${spook - 1}`, mass);
      } else { letters += mass * PU_DUPLICATE_LETTERS; add2(`${Math.min(main + 1, FOCUS_HIT_CAP)}:${pu}:${spook}`, mass); }
    }
    states = exchanged;

    const keep = new Map();
    let finished = 0;
    for (const [key, mass] of states) {
      const [main, pu, spook] = key.split(':').map(Number);
      if (main >= 1 && pu + spook >= others) finished += mass; else keep.set(key, mass);
    }
    stopAt[block * EXCHANGE_INTERVAL] = finished;
    lettersAt[block * EXCHANGE_INTERVAL] = letters;
    states = keep;
    live -= finished;
    if (live < 1e-12) break;
  }
  return { stopAt, lettersAt, unfinished: Math.max(0, live), letters, pulls };
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

  // 「本命1名を狙い続ける」意味を、開始時の素体0人/1人の2ケースで測る。
  const focusPlans = [
    { id: 'pointFocus', useCharge: false, useExchange: true, focus: true },
    { id: 'pointSpread', useCharge: false, useExchange: true, focus: false },
    { id: 'chargeFocus', useCharge: true, useExchange: false, focus: true },
    { id: 'chargeSpread', useCharge: true, useExchange: false, focus: false },
  ];
  const focus = Object.fromEntries([0, 1].map((ownedAtStart) => [
    ownedAtStart,
    Object.fromEntries(focusPlans.map((plan) => [plan.id, runFocusStrategy(ownedAtStart, plan)])),
  ]));

  // 呼出チャージで素体だけそろえて撤退する運用。すり抜けの得失を測る。
  const retreat = Object.fromEntries(TARGETS.map((target) => [target, {
    withSpook: runRetreat(target, { allowSpook: true }),
    withoutSpook: runRetreat(target, { allowSpook: false }),
  }]));

  // 呼出ポイントで本命に集中したとき、交換枠の流し先で結果がどう変わるか。
  const exchangePlans = [
    { id: 'subThenMain', plan: ['sub', 'main'] },
    { id: 'subThenVeteran', plan: ['sub', 'veteran'] },
    { id: 'bothVeteran', plan: ['veteran', 'veteran'] },
    { id: 'bothMain', plan: ['main', 'main'] },
  ];
  const focusExchange = Object.fromEntries([200, 400].map((limit) => [
    limit,
    Object.fromEntries(exchangePlans.map(({ id, plan }) => [id, runFocusExchange(limit, plan)])),
  ]));

  // そろったら止める前提での、呼出ポイント2PUの現実的な進め方。
  const blockRun = Object.fromEntries([2, 3].map((targets) => [targets, {
    focus: runBlockRun(targets, { focus: true }),
    sequential: runBlockRun(targets, { focus: false }),
  }]));

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
    focus,
    retreat,
    focusExchange,
    blockRun,
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
  2: '新規の先生が水着イロハと水着イブキを狙う想定です。',
  3: '制服ネルかリオをすり抜けで確保済みの先生が、残り3名を狙う想定です。',
  4: 'これから始める先生が対象4名すべてを狙う想定です。',
};

function retreatSection(result) {
  const tabs = TARGETS.map((target) => `<button type="button" role="tab" id="tab-${target}pu" aria-controls="pu-panel" aria-selected="${target === 2}" tabindex="${target === 2 ? 0 : -1}" data-pu="${target}">${PU_TAB_NAMES[target]}</button>`).join('');
  const panels = TARGETS.map((target) => {
    const withSpook = result.retreat[target].withSpook;
    const without = result.retreat[target].withoutSpook;
    const savedPulls = without.expectedPulls - withSpook.expectedPulls;
    const lostLetters = without.letters - withSpook.letters;
    return `<div data-pu-panel="${target}"${target === 2 ? '' : ' hidden'}><p>${PU_TAB_LEAD[target]}素体がそろった時点で撤退する前提です。</p><table><colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup><thead><tr><th>そろえ方</th><th>期待募集回数</th><th>持ち帰る文字</th></tr></thead><tbody><tr><th>すべて指名で引く</th><td>${without.expectedPulls.toFixed(1)}連</td><td class="best">${Math.round(without.letters)}文字</td></tr><tr><th>すり抜けを含む実際</th><td class="best">${withSpook.expectedPulls.toFixed(1)}連</td><td>${Math.round(withSpook.letters)}文字</td></tr><tr><th>差</th><td>−${savedPulls.toFixed(1)}連</td><td>−${Math.round(lostLetters)}文字</td></tr><tr><th>すり抜けで決着した割合</th><td colspan="2">${(withSpook.finishedViaSpook * 100).toFixed(2)}%</td></tr></tbody></table><p class="note">すり抜けで相方が来ると、その生徒を指名せずに済むぶん早く終わります。そのかわり、指名して引いていれば付いたはずの初回PUボーナスが手に入らないため、文字は目減りします。</p><p class="note">相方が素体確保で十分な性能なら、これは早く終わって得をした話です。相方にも固有2が要るなら、撤退せず指名を続けることになります。そのときは先に素体を持っているぶん、次に引き当てた1回が重複100文字と未消費の初回ボーナス100文字で<b>200文字</b>になり、取り逃した100文字はそこで戻ります。</p></div>`;
  }).join('');
  return `<section class="panel"><h2>新仕様は全員そろえるまで降りられない</h2><p>呼出チャージには交換がないので、狙った生徒は順番に指名して引き当てるしかありません。まず素体をそろえるまでの期待値を置き、そこにすり抜けが挟まると何が変わるかを見ます。</p><div class="tabs" role="tablist" aria-label="狙う人数">${tabs}</div><div id="pu-panel" role="tabpanel" aria-labelledby="tab-2pu">${panels}</div></section>`;
}

// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。
const EXCHANGE_PLAN_LABELS = [
  ['subThenMain', 'イブキを確保 → 残りはイロハ'],
  ['subThenVeteran', 'イブキを確保 → 残りは既所持のネル'],
];

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');

const BLOCK_PLAN_LABELS = [['focus', 'イロハに集中'], ['sequential', '引けたら次の生徒へ']];

/** 200連ブロックごとの撤退確率。悲惨な残業がどれだけの確率で起きるかを見る。 */
function blockStopRows(result, targets) {
  const plans = result.blockRun[targets];
  const blocks = [200, 400, 600, 800].filter((pull) => pull in plans.focus.stopAt || pull in plans.sequential.stopAt);
  return BLOCK_PLAN_LABELS.map(([id, label]) => {
    const row = plans[id];
    const cells = blocks.map((pull) => {
      const value = row.stopAt[pull] ?? 0;
      const rival = plans[id === 'focus' ? 'sequential' : 'focus'].stopAt[pull] ?? 0;
      const mark = pull <= 200 && value > rival + 1e-9 ? ' class="best"' : '';
      return `<td${mark}>${(value * 100).toFixed(1)}%</td>`;
    }).join('');
    return `<tr><th>${label}</th>${cells}<td>${stone(row.pulls)}石</td><td>${Math.round(row.letters)}文字</td></tr>`;
  });
}

function blockStopHead(result, targets) {
  const plans = result.blockRun[targets];
  const blocks = [200, 400, 600, 800].filter((pull) => pull in plans.focus.stopAt || pull in plans.sequential.stopAt);
  return blocks.map((pull) => `<th>${pull}連</th>`).join('');
}

/** 素体をそろえるまでに何石かかるか。新仕様の言い分をそのまま数字にする。 */
function costRows(result) {
  return TARGETS.map((target) => {
    const charge = result.scenarios.charge[target].expectedPullsToAllBase;
    const point = result.scenarios.point[target].expectedPullsToAllBase;
    const gap = (point - charge) * PYROXENE_PER_PULL;
    const chargeMark = charge <= point ? ' class="best"' : '';
    const pointMark = point < charge ? ' class="best"' : '';
    return `<tr><th>${target}名</th><td${chargeMark}>${charge.toFixed(1)}連<small>${stone(charge)}石</small></td><td${pointMark}>${point.toFixed(1)}連<small>${stone(point)}石</small></td><td>${gap >= 0 ? '新が' : '旧が'}${Math.abs(Math.round(gap)).toLocaleString('ja-JP')}石${gap >= 0 ? '安い' : '安い'}</td></tr>`;
  });
}

/** 同じ連数を積んだ場合に持ち帰る文字。石あたりの実入りを比べる。 */
function sameBudgetRows(result) {
  return TARGETS.map((target) => {
    const cells = [200, 400].map((pull) => {
      const charge = result.scenarios.charge[target].letters[pull];
      const point = result.scenarios.point[target].letters[pull];
      return `<td>${Math.round(charge)}文字</td><td class="best">${Math.round(point)}文字</td><td>+${Math.round(point - charge)}</td>`;
    }).join('');
    return `<tr><th>${target}名</th>${cells}</tr>`;
  });
}

function exchangePlanRows(result) {
  const plans = result.focusExchange[400];
  const bestLetters = Math.max(...EXCHANGE_PLAN_LABELS.map(([id]) => plans[id].letters));
  const bestUe2 = Math.max(...EXCHANGE_PLAN_LABELS.map(([id]) => plans[id].mainUe2));
  return EXCHANGE_PLAN_LABELS.map(([id, label]) => {
    const row = plans[id];
    const letterMark = row.letters >= bestLetters - 1e-9 ? ' class="best"' : '';
    const ue2Mark = row.mainUe2 >= bestUe2 - 1e-9 ? ' class="best"' : '';
    const subMark = row.subNone < 1e-9 ? ' class="best"' : '';
    return `<tr><th>${label}</th><td${letterMark}>${Math.round(row.letters)}文字</td><td${ue2Mark}>${(row.mainUe2 * 100).toFixed(1)}%</td><td${subMark}>${((1 - row.subNone) * 100).toFixed(1)}%</td></tr>`;
  });
}

/** 本命と相方を何体お迎えできたかの同時分布。3体以上はまとめる。 */
function jointTable(result, limit, planId) {
  const { joint } = result.focusExchange[limit][planId];
  const bucket = Array.from({ length: 4 }, () => Array(4).fill(0));
  joint.forEach((row, main) => row.forEach((mass, sub) => {
    bucket[Math.min(main, 3)][Math.min(sub, 3)] += mass;
  }));
  const label = (count) => (count === 3 ? '3体以上' : `${count}体`);
  const head = [0, 1, 2, 3].map((sub) => `<th>イブキ${label(sub)}</th>`).join('');
  const rows = bucket.map((row, main) => {
    const cells = row.map((mass) => {
      const mark = mass >= 0.1 ? ' class="best"' : '';
      return `<td${mark}>${(mass * 100).toFixed(1)}%</td>`;
    }).join('');
    return `<tr><th>イロハ${label(main)}</th>${cells}</tr>`;
  }).join('');
  return `<table><colgroup><col style="width:28%"><col style="width:18%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup><thead><tr><th>お迎え数</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
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

const FESTIVAL_CSS = ':root{color-scheme:light dark;--surface:#faf6ef;--raised:#fffdf8;--on:#3a2f28;--muted:#6f6257;--border:#e3d9c9;--accent:#9a6a00;--accent-subtle:rgba(154,106,0,.10);--link:#14506e;--series-charge:#14506e;--series-point:#9a6a00;--grid-minor:#e3d9c9;--grid-major:#a99c8e}*{box-sizing:border-box}html{background:var(--surface)}body{margin:0;background:var(--surface);color:var(--on);font-family:system-ui,sans-serif;font-size:16px;line-height:1.6}a{color:var(--link)}a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}main{width:min(1100px,calc(100% - 24px));margin:24px auto}.nav{display:flex;gap:16px;margin-bottom:16px;border-bottom:1px solid var(--border)}.nav a{padding:8px 4px;color:var(--muted);font-size:15px;font-weight:500;text-decoration:none}.nav a[aria-current]{color:var(--on);border-bottom:2px solid var(--accent)}h1,h2{font-size:17px;font-weight:600;line-height:1.3}h3{font-size:15px;font-weight:600;margin:0 0 8px}.hero{padding:16px 0 24px}.header-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.hero h1{margin:0}.lead{color:var(--muted);margin:8px 0 0}.repo-link{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-decoration:none}.repo-link:hover{color:var(--link)}.repo-link svg{width:20px;height:20px;flex:none}.panel{background:var(--raised);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px}.panel h2{margin:0 0 12px}.panel p{margin:0 0 12px}.panel p:last-child{margin-bottom:0}.rules{margin:0;padding:0;list-style:none}.rules li{padding:6px 0;border-bottom:1px dashed var(--border);font-size:15px}.rules li:last-child{border-bottom:0}.rules b{color:var(--accent)}details summary{cursor:pointer;font-weight:600;font-size:15px;padding:2px 0;color:var(--muted)}details[open] summary{margin-bottom:8px;color:var(--on)}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tabs{display:flex;gap:4px;margin:0 0 12px}.tabs button{flex:1 1 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--muted);font:500 15px/1.2 system-ui,sans-serif;cursor:pointer}.tabs button[aria-selected="true"]{background:var(--accent-subtle);border-color:var(--accent);color:var(--on)}table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}th,td{padding:8px 6px;border-bottom:1px solid var(--border);text-align:right;vertical-align:top}thead th{text-align:center;color:var(--muted);font-size:13px;font-weight:600}tbody th{text-align:left;font-size:14px;white-space:nowrap}tbody th.sub{color:var(--muted);font-weight:500}td b{display:block;font-size:15px;font-weight:600;white-space:nowrap}td small{display:block;color:var(--muted);font-size:11px;line-height:1.3;margin-bottom:4px}td small:last-child{margin-bottom:0}tbody+tbody th,tbody+tbody td{border-top:2px solid var(--grid-major)}b.best{color:var(--link)}b.best:after{content:"\\2009\\25B8";font-size:11px;vertical-align:1px}.best{color:var(--link);font-weight:600}.note{color:var(--muted);font-size:14px;margin:12px 0 0}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}@media(max-width:760px){main{width:min(100% - 16px,1100px);margin:16px auto}.panel{padding:12px 8px}.hero{padding-top:8px}.repo-link span{display:none}th,td{padding:8px 4px}.rules li{font-size:14px}}@media(prefers-color-scheme:dark){:root{--surface:#191919;--raised:#232323;--on:#e6e6e6;--muted:#9a9a9a;--border:#333333;--accent:#e0a800;--accent-subtle:rgba(224,168,0,.15);--link:#7fdbff;--series-charge:#7fdbff;--series-point:#e0a800;--grid-minor:#333;--grid-major:#666}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}';

const GITHUB_LINK = '<a class="repo-link" href="https://github.com/miyabisun/arona-gacha-calc" aria-label="GitHubリポジトリを開く"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.5 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/></svg><span>miyabisun/arona-gacha-calc</span></a>';


function renderFestivalHtml(result) {
  const rates = result.rates;
  const banking = result.banking;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5フェス限の新旧比較</title><style>
${FESTIVAL_CSS}
</style></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5フェス限の新旧比較</h1>${GITHUB_LINK}</div><p class="lead">フェス限定募集は星3が6%へ倍化し、指名していないフェス限生徒も出現します。この「すり抜け」で狙っている別の生徒が手に入るため、呼出ポイントの200連区切りが有利になる場面があります。</p></header>
<section class="panel"><details><summary>計算に使う前提</summary><ul class="rules"><li>フェス限定募集の星3排出率は <b>${pct(rates.festivalStar3)}</b>。</li><li>指名した1名の排出率は <b>${pct(rates.namedPu)}</b>。呼出チャージではチャージ99で50%、199で100%。</li><li>新旧フェス限10名から指名中の1名を除いた<b>9名</b>が <b>${pct(rates.spookPoolTotal)}</b> を等分し、1名あたり <b>${pct(rates.spookEach)}</b>。</li><li>残る <b>${pct(rates.otherStar3)}</b> は恒常星3で、内訳として記録するだけで計算には使いません。</li><li>初回PUボーナスは<b>指名PUの自引きと呼出ポイント交換</b>でのみ得られます。すり抜けで確保しても付きません。</li><li>素体を持たない生徒を優先して指名し、全員が素体済みなら素体持ちを指名してボーナスだけ回収します。</li><li>文字と欠片は分けて数えます。欠片は手持ちが潤沢な先生が多く、文字と同じ重みでは扱えないためです。</li></ul></details></section>
${retreatSection(result)}
<section class="panel"><h2>新仕様の言い分：石が安く済む</h2><p>ここまでは同じ連数を積んだ場合の話でした。新仕様の主張は<b>そもそも積む石が少なくて済む</b>ことで、これは事実です。素体をそろえた時点で降りられるなら、浮いた石はそのまま次の限定・恒常募集へ回せます。</p><h3>素体をそろえるまでの費用</h3><table><colgroup><col style="width:22%"><col style="width:30%"><col style="width:30%"><col style="width:18%"></colgroup><thead><tr><th>狙う人数</th><th>呼出チャージ</th><th>呼出ポイント</th><th>差</th></tr></thead><tbody>${costRows(result).join('')}</tbody></table><p class="note">2名なら1,441石、12連ぶん安く上がります。ただし差は狙う人数が増えるほど縮み、<b>4名では逆に呼出ポイントのほうが268石安くなります</b>。新仕様の強みは、狙う人数が少ないときに限って効きます。</p><h3>同じ石を積んだ場合に持ち帰る文字</h3><table><colgroup><col style="width:16%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th rowspan="2">狙う人数</th><th colspan="3">200連（24,000石）</th><th colspan="3">400連（48,000石）</th></tr><tr><th>チャージ</th><th>ポイント</th><th>差</th><th>チャージ</th><th>ポイント</th><th>差</th></tr></thead><tbody>${sameBudgetRows(result).join('')}</tbody></table><p class="note">同じ石を積むなら、旧仕様のほうが400連で64〜70文字多く持ち帰ります。浮く石の12連ぶんを恒常募集へ回しても星3は0.36人ぶんで、64文字は固有2の19%にあたります。この二つを同じ物差しで比べることはできません。それでも、降りられる代わりに毎回この差を払い続けることになります。</p></section>
<section class="panel"><h2>旧仕様なら上振れを選びにいける</h2><p>ならば旧仕様にも上振れはあるはずだ、という話になります。呼出ポイントは<b>水着イロハを指名し続けたまま、200連ごとの交換枠を使い分けられます</b>。この自由度が新仕様には存在しません。</p><p>ただし<b>フェス限を取り逃す選択肢はありません</b>。イブキが未所持なら1枠目は必ずイブキの確保に使います。ここは新仕様でも確実に取れるところで、両者の差が出ない部分です。</p><p>差が出るのは2枠目です。交換枠の値打ちは相手によって変わり、未所持の生徒を引き取れば素体と初回ボーナス100文字。すでに素体を持っていて初回ボーナスが未消費の生徒——たとえば<b>制服ネルを固有3で止めている先生</b>なら、重複100文字と初回ボーナス100文字で<b>200文字</b>になります。</p><h3>400連・交換2枠の使い道</h3><table><colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup><thead><tr><th>交換枠の流し先</th><th>持ち帰る文字</th><th>イロハ固有2</th><th>イブキ確保</th></tr></thead><tbody>${exchangePlanRows(result).join('')}</tbody></table><p class="note">イブキを確保したうえで、2枠目をイロハに回せば固有2到達が77.0%になり、既所持のネルに回せば文字が100文字増えて605文字になります。イロハの凸を進めるか、手持ちの生徒の凸を進めるか——<b>どちらを選ぶかを先生が決められること自体が、新仕様には無い価値です。</b>呼出チャージには、この2枠目にあたるものが存在しません。</p><h3>400連で何体お迎えできるか（イブキを確保して残りはイロハ）</h3>${jointTable(result, 400, 'subThenMain')}<p class="note">イロハを3体そろえれば353文字で固有2に届きます。この進め方なら<b>イブキは必ず1体以上</b>手に入り、そのうえでイロハが3体以上に達する確率が77.0%です。</p></section>
<section class="panel"><h2>実際にはどこで降りるのか</h2><p>ここまでは400連を引き切る前提でした。実戦では<b>素体がそろったブロックの終わりで降ります</b>。文字が欲しいからといって、そろい切った状態から追加の200連を回すことはありません。交換枠は未所持がいれば必ずそこへ使います。</p><h3>2PU（水着イロハ・水着イブキ）</h3><table><colgroup><col style="width:28%"><col style="width:18%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup><thead><tr><th>進め方</th>${blockStopHead(result, 2)}<th>期待消費</th><th>期待文字</th></tr></thead><tbody>${blockStopRows(result, 2).join('')}</tbody></table><p class="note">2PUでは進め方を変えても降りる時点は動きません。<b>約8割が200連で解放され、残る2割が400連の残業に回ります</b>。イロハに集中したほうが重複ぶんで8文字だけ多く残りますが、素体をそろえる速さは同じです。</p><p class="note">どちらの場合も期待文字は300前後にとどまります。イブキが素体確保で十分な性能なら、これで目的は果たせています。イブキにも固有2が要るなら<b>340文字には遠く届かず</b>、このガチャだけでは完結しません。</p><h3>3PU（水着イロハ・水着イブキ・制服ネル）</h3><table><colgroup><col style="width:28%"><col style="width:14%"><col style="width:14%"><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup><thead><tr><th>進め方</th>${blockStopHead(result, 3)}<th>期待消費</th><th>期待文字</th></tr></thead><tbody>${blockStopRows(result, 3).join('')}</tbody></table><p class="note">3PUになると進め方で結果が割れます。引けたら次の生徒へ移れば<b>200連で降りられる確率が50.6%</b>まで上がり、期待消費は36,640石。イロハに集中すると200連での解放は25.7%に半減し、期待消費は44,477石へ膨らみます。そのかわり集中したほうが<b>76文字多く</b>持ち帰ります。</p><p class="note">7,837石を積んで76文字を買う取引だと言い換えられます。アタッカーの固有2を急ぐなら悪くありませんが、素体をそろえて次の募集へ石を残したいなら、素直に引けた順で乗り換えるほうが安く上がります。<b>この判断を先生が持てること自体が、呼出ポイントにしかない性質です。</b></p></section>
<section class="panel"><h2>凸のどこまで届くか</h2><table><colgroup><col style="width:22%"><col style="width:22%"><col style="width:28%"><col style="width:28%"></colgroup><thead><tr><th>到達段位</th><th>必要文字</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead><tbody>${milestoneRows(result).join('')}</tbody></table><p class="note">3名を狙った場合に、対象3名分を合計した文字が段位のコストへ届く連数です。1名へ集中させた場合の数字ではありません。星3を出発点として星4に100文字、固有1にさらに120文字、固有2に120文字、固有3に180文字、固有4に200文字が必要です。</p></section>
<section class="panel"><h2>区切りまで回したときの到達率</h2><table><colgroup><col style="width:16%"><col style="width:16%"><col style="width:34%"><col style="width:34%"></colgroup><thead><tr><th>狙う人数</th><th>連数</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead>${reachRows(result).join('')}</table><p class="note">呼出ポイントは200連ごとに1名を確実に交換できるため、区切りちょうどで見ると呼出チャージより高くなります。狙う人数が増えるほど差は開きます。</p></section>
<section class="panel"><h2>降りどきが選べるかどうか</h2><p>呼出チャージは全員そろうまで降りにくく、呼出ポイントは200連ごとに続行か撤退かを選べます。下は呼出チャージで全員の素体がそろう連数の散らばりで、半分の先生は中央値で降りられますが、残り半分はそこから先も払い続けることになります。</p><table><colgroup><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup><thead><tr><th>狙う人数</th><th>半数</th><th>4人に3人</th><th>10人に9人</th><th>最悪</th></tr></thead><tbody>${riskRows(result).join('')}</tbody></table><p class="note">呼出ポイントなら200連で1名分の交換が確定するため、同じ予算を決め打ちで投じても手ぶらになりません。呼出チャージは天井が200連ごとに区切られる点は同じですが、自引きがそのままチャージを消費するので、取得機会が交換ぶんだけ少なくなります。</p></section>
<section class="panel"><h2>すり抜け狙いは作戦になるか</h2><p>指名した生徒を引き当てる前にすり抜けが来れば、その生徒を交換に回して<b>重複100文字＋初回ボーナス100文字＋50欠片</b>を一度に得られます。狙う価値があるかを測るため、1人目を引き当てるまでにすり抜けが来る確率を出しました。</p><table><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup><thead><tr><th>待っている枠</th><th>呼出チャージ</th><th>呼出ポイント</th><th>差</th></tr></thead><tbody><tr><th>1枠</th><td>8.43%</td><td class="best">12.50%</td><td>+4.07pt</td></tr><tr><th>2枠</th><td>15.86%</td><td class="best">22.22%</td><td>+6.36pt</td></tr><tr><th>3枠</th><td>22.45%</td><td class="best">30.00%</td><td>+7.55pt</td></tr></tbody></table><p class="note">呼出ポイントが上回るのは、1人目にかかる平均が142.9連と長く、その間ずっと枠が生きているからです。呼出チャージは90.1連で決着してしまい、100連目の50%と200連目の確定枠に待ち時間を打ち切られます。</p><p class="note">ただし、これを積極的に狙う価値はありません。すり抜け済みの生徒を優先して交換に回しても、400連で得られる文字は3文字しか増えず（3名狙いで504文字が507文字）、素体のそろう確率は2.7pt下がります。さらに、すり抜け枠を保つために既所持の生徒を指名し続ける「片方寄せ」まで踏み込むと、文字は36文字増える一方で素体は29.7pt落ちます。指名は0.7%、すり抜けは1枠あたり0.1%です。3.5倍強い手段を捨てて枠を温存する取引は、どう組んでも割に合いません。</p></section>
<section class="panel"><h2>そろうまでの期待募集回数</h2><table><colgroup><col style="width:20%"><col style="width:40%"><col style="width:40%"></colgroup><thead><tr><th>狙う人数</th><th>呼出チャージ</th><th>呼出ポイント</th></tr></thead><tbody>${expectationRows(result).join('')}</tbody></table><p class="note">区切りを気にせず引き続けた場合の平均です。到達率の表とは逆に、2名・3名では呼出チャージのほうが短く済みます。区切りで止めるか揃うまで回すかで、有利な仕様が入れ替わります。</p></section>
<section class="panel"><h2>99連を次の限定募集へ持ち越す</h2><p>呼出チャージは募集の種別ごとに引き継がれます。フェス限定募集で貯めたチャージは<b>次の限定募集やフェス限定募集</b>へ、恒常募集のチャージは次の恒常募集へ持ち越せます。</p><p>そこで、フェス限定募集の期間に<b>99連まで進めて止めておき</b>、次の限定募集をチャージ99の状態で始める作戦が成立します。1連目にいきなり50%の確定枠が来て、外しても<b>${banking.guaranteedWithinBanked}連目</b>には199の確定枠へ届きます。</p><table><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup><thead><tr><th>1人を確保するまで</th><th>期待</th><th>最大</th><th>短縮</th></tr></thead><tbody><tr><th>チャージ0から</th><td>${banking.expectedPullsPlain.toFixed(1)}連</td><td>${banking.guaranteedWithinPlain}連</td><td>—</td></tr><tr><th>チャージ99から</th><td class="best">${banking.expectedPullsBanked.toFixed(1)}連</td><td class="best">${banking.guaranteedWithinBanked}連</td><td class="best">−${banking.savedPulls.toFixed(1)}連</td></tr></tbody></table><p class="note">持ち越したチャージは1人目にしか効かないため、短縮量は狙う人数によらず一定です。表の連数には、貯めるために使った99連そのものを含みません。</p><h3>どこで99連を貯めるか</h3><p>同じ99連でも、貯める場所によって副産物が変わります。フェス限定募集は星3が <b>${pct(rates.festivalStar3)}</b> なので99連あたり期待 <b>${banking.festivalStar3PerBank.toFixed(2)}人</b>。限定募集は <b>${pct(rates.limitedStar3)}</b> のままなので <b>${banking.limitedStar3PerBank.toFixed(2)}人</b> にとどまります。貯めるなら星3が倍のフェス限定募集のあいだに進めておくほうが、同じ連数で多く拾えます。</p><p class="note">ただし恒常星3の価値は1人あたり30文字と50欠片で、欲しい生徒が恒常の分母にどれだけ含まれるか次第です。「倍拾える」がそのまま「倍うれしい」にはなりません。</p><p class="note">また、貯めている途中で指名した生徒を引き当てるとチャージは0に戻ります。99連を引ききってもチャージが残っている確率は <b>${pct(banking.survivalToBank)}</b> です。199連まで貯めて次の募集を1連で終わらせる案は、そこへ到達する前に約87.5%がチャージを失うため実用になりません。</p></section>
<footer>Generated by scripts/festival.js</footer></main>
<script>const puTabs=[...document.querySelectorAll('[data-pu]')],puPanels=[...document.querySelectorAll('[data-pu-panel]')];const selectPu=value=>{puTabs.forEach(tab=>{const on=tab.dataset.pu===value;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1});puPanels.forEach(panel=>{panel.hidden=panel.dataset.puPanel!==value});document.getElementById('pu-panel').setAttribute('aria-labelledby','tab-'+value+'pu')};puTabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectPu(tab.dataset.pu));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowLeft')next=(index-1+puTabs.length)%puTabs.length;if(event.key==='ArrowRight')next=(index+1)%puTabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=puTabs.length-1;puTabs[next].focus();selectPu(puTabs[next].dataset.pu)})});</script></body></html>`;
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
  ['<summary>計算に使う前提</summary>', '<summary>Assumptions</summary>'],
  [
    '<li>文字と欠片は分けて数えます。欠片は手持ちが潤沢な先生が多く、文字と同じ重みでは扱えないためです。</li>',
    '<li>Eleph and shards are counted separately. Most players sit on a large shard stock, so shards cannot carry the same weight as Eleph.</li>',
  ],
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
  ['<h2>新仕様は全員そろえるまで降りられない</h2>', '<h2>Recruitment Charge gives you no exit</h2>'],
  [
    '<p>呼出チャージには交換がないので、狙った生徒は順番に指名して引き当てるしかありません。まず素体をそろえるまでの期待値を置き、そこにすり抜けが挟まると何が変わるかを見ます。</p>',
    '<p>Recruitment Charge has no exchange, so every student you want has to be selected and pulled in turn. Start from the expected cost of simply owning them, then see what changes when an off-target pull lands.</p>',
  ],
  ['新規の先生が水着イロハと水着イブキを狙う想定です。', 'A new player going after Swimsuit Iroha and Swimsuit Ibuki.'],
  ['制服ネルかリオをすり抜けで確保済みの先生が、残り3名を狙う想定です。', 'A player who already picked up Uniform Nel or Rio, going after the other three.'],
  ['これから始める先生が対象4名すべてを狙う想定です。', 'A player starting now, going after all four featured students.'],
  ['素体がそろった時点で撤退する前提です。', 'The run stops as soon as every student is owned.'],
  ['<th>そろえ方</th>', '<th>How they arrive</th>'],
  ['<th>期待募集回数</th>', '<th>Expected pulls</th>'],
  ['<th>持ち帰る文字</th>', '<th>Eleph earned</th>'],
  ['<th>すべて指名で引く</th>', '<th>All by selection</th>'],
  ['<th>すり抜けを含む実際</th>', '<th>Including off-target</th>'],
  ['<th>すり抜けで決着した割合</th>', '<th>Settled by an off-target pull</th>'],
  ['aria-label="狙う人数"', 'aria-label="Number of students targeted"'],
  [
    '<p class="note">すり抜けで相方が来ると、その生徒を指名せずに済むぶん早く終わります。そのかわり、指名して引いていれば付いたはずの初回PUボーナスが手に入らないため、文字は目減りします。</p>',
    '<p class="note">When an off-target pull delivers a partner, that student never has to be selected, so the run ends sooner. In exchange the first-time bonus that selecting would have paid never arrives, and the Eleph haul shrinks.</p>',
  ],
  [
    '<p class="note">相方が素体確保で十分な性能なら、これは早く終わって得をした話です。相方にも固有2が要るなら、撤退せず指名を続けることになります。そのときは先に素体を持っているぶん、次に引き当てた1回が重複100文字と未消費の初回ボーナス100文字で<b>200文字</b>になり、取り逃した100文字はそこで戻ります。</p>',
    '<p class="note">If simply owning the partner is enough, finishing early is a straight win. If the partner also needs UE2, you keep selecting instead of walking away — and because the unit is already owned, the next hit pays 100 Eleph for the duplicate plus the unspent 100 Eleph bonus, <b>200 Eleph</b> in one go. The 100 you appeared to lose comes back there.</p>',
  ],
  ['<h2>新仕様の言い分：石が安く済む</h2>', '<h2>The case for Recruitment Charge: it costs less</h2>'],
  [
    '<p>ここまでは同じ連数を積んだ場合の話でした。新仕様の主張は<b>そもそも積む石が少なくて済む</b>ことで、これは事実です。素体をそろえた時点で降りられるなら、浮いた石はそのまま次の限定・恒常募集へ回せます。</p>',
    '<p>Everything above assumed the same number of pulls. The case for the new system is that <b>fewer pulls are needed in the first place</b> — and that is true. If you can walk away once every student is owned, the Pyroxene you never spent carries straight into the next limited or standard banner.</p>',
  ],
  ['<h3>素体をそろえるまでの費用</h3>', '<h3>Cost to own every student</h3>'],
  ['<td>新が', '<td>Charge by '],
  ['<td>旧が', '<td>Points by '],
  ['石安い</td>', ' Pyroxene</td>'],
  ['石</td>', ' Pyroxene</td>'],
  ['連<small>', ' pulls<small>'],
  ['石</small>', ' Pyroxene</small>'],
  [
    '<p class="note">2名なら1,441石、12連ぶん安く上がります。ただし差は狙う人数が増えるほど縮み、<b>4名では逆に呼出ポイントのほうが268石安くなります</b>。新仕様の強みは、狙う人数が少ないときに限って効きます。</p>',
    '<p class="note">Targeting two students saves 1,441 Pyroxene, about twelve pulls. The gap narrows as you target more, and <b>at four students Recruitment Points is actually 268 Pyroxene cheaper</b>. The new system\'s advantage holds only when you are after a small number of students.</p>',
  ],
  ['<h3>同じ石を積んだ場合に持ち帰る文字</h3>', '<h3>Eleph earned for the same Pyroxene</h3>'],
  ['<th rowspan="2">狙う人数</th>', '<th rowspan="2">Students</th>'],
  ['<th colspan="3">200連（24,000石）</th>', '<th colspan="3">200 pulls (24,000 Pyroxene)</th>'],
  ['<th colspan="3">400連（48,000石）</th>', '<th colspan="3">400 pulls (48,000 Pyroxene)</th>'],
  ['<th>チャージ</th>', '<th>Charge</th>'],
  ['<th>ポイント</th>', '<th>Points</th>'],
  [
    '<p class="note">同じ石を積むなら、旧仕様のほうが400連で64〜70文字多く持ち帰ります。浮く石の12連ぶんを恒常募集へ回しても星3は0.36人ぶんで、64文字は固有2の19%にあたります。この二つを同じ物差しで比べることはできません。それでも、降りられる代わりに毎回この差を払い続けることになります。</p>',
    '<p class="note">Spend the same Pyroxene and the old system carries away 64 to 70 more Eleph over 400 pulls. Rolling the twelve saved pulls into a standard banner returns about 0.36 of a 3★, while 64 Eleph is 19% of the way to UE2. The two cannot be measured on one scale. Even so, the option to walk away is paid for with this gap, banner after banner.</p>',
  ],
  ['<h2>旧仕様なら上振れを選びにいける</h2>', '<h2>Recruitment Points lets you choose your upside</h2>'],
  [
    '<p>ならば旧仕様にも上振れはあるはずだ、という話になります。呼出ポイントは<b>水着イロハを指名し続けたまま、200連ごとの交換枠を使い分けられます</b>。この自由度が新仕様には存在しません。</p>',
    '<p>So the natural question is whether the old system has upside of its own. It does: Recruitment Points lets you <b>stay on Swimsuit Iroha the whole way while directing each 200-point exchange where it helps most</b>. Recruitment Charge offers no such choice.</p>',
  ],
  [
    '<p>ただし<b>フェス限を取り逃す選択肢はありません</b>。イブキが未所持なら1枠目は必ずイブキの確保に使います。ここは新仕様でも確実に取れるところで、両者の差が出ない部分です。</p>',
    '<p>That said, <b>letting a festival student slip away is never an option</b>. If Ibuki is not owned, the first exchange always goes to securing her. The new system reaches that same point reliably too, so nothing separates them here.</p>',
  ],
  [
    '<p>差が出るのは2枠目です。交換枠の値打ちは相手によって変わり、未所持の生徒を引き取れば素体と初回ボーナス100文字。すでに素体を持っていて初回ボーナスが未消費の生徒——たとえば<b>制服ネルを固有3で止めている先生</b>なら、重複100文字と初回ボーナス100文字で<b>200文字</b>になります。</p>',
    '<p>The difference shows up in the second exchange. What it is worth depends on who you spend it on: a student you do not own yields the unit plus a 100 Eleph first-time bonus, while one you already own whose bonus is still unspent — say <b>a player sitting on Uniform Nel at UE3</b> — pays 100 Eleph for the duplicate plus the 100 Eleph bonus, for <b>200 Eleph</b>.</p>',
  ],
  ['<h3>400連・交換2枠の使い道</h3>', '<h3>Spending the two exchanges over 400 pulls</h3>'],
  ['<th>交換枠の流し先</th>', '<th>Where the exchanges go</th>'],
  ['<th>イロハ固有2</th>', '<th>Iroha at UE2</th>'],
  ['<th>イブキ確保</th>', '<th>Ibuki owned</th>'],
  // 長い本文を先に置換する。あとに続く短いラベルが本文の一部を書き換えてしまうため。
  [
    '<p class="note">イブキを確保したうえで、2枠目をイロハに回せば固有2到達が77.0%になり、既所持のネルに回せば文字が100文字増えて605文字になります。イロハの凸を進めるか、手持ちの生徒の凸を進めるか——<b>どちらを選ぶかを先生が決められること自体が、新仕様には無い価値です。</b>呼出チャージには、この2枠目にあたるものが存在しません。</p>',
    '<p class="note">With Ibuki secured, sending the second exchange into Iroha lifts her UE2 rate to 77.0%, while sending it into an already-owned Nel adds 100 Eleph for 605 total. Push the featured attacker further, or push a student already on your roster — <b>having that choice at all is worth something the new system does not offer.</b> Recruitment Charge has no second exchange to spend.</p>',
  ],
  ['イブキを確保 → 残りはイロハ', 'Secure Ibuki, then Iroha'],
  ['イブキを確保 → 残りは既所持のネル', 'Secure Ibuki, then owned Nel'],
  ['<h3>400連で何体お迎えできるか（イブキを確保して残りはイロハ）</h3>', '<h3>How many arrive over 400 pulls (secure Ibuki, then Iroha)</h3>'],
  ['<th>お迎え数</th>', '<th>Copies</th>'],
  [
    '<p class="note">イロハを3体そろえれば353文字で固有2に届きます。この進め方なら<b>イブキは必ず1体以上</b>手に入り、そのうえでイロハが3体以上に達する確率が77.0%です。</p>',
    '<p class="note">Three copies of Iroha come to 353 Eleph, which clears UE2. On this plan <b>Ibuki always arrives at least once</b>, and Iroha still reaches three or more copies 77.0% of the time.</p>',
  ],
  ['<h2>実際にはどこで降りるのか</h2>', '<h2>Where the run actually ends</h2>'],
  [
    '<p>ここまでは400連を引き切る前提でした。実戦では<b>素体がそろったブロックの終わりで降ります</b>。文字が欲しいからといって、そろい切った状態から追加の200連を回すことはありません。交換枠は未所持がいれば必ずそこへ使います。</p>',
    '<p>Everything so far assumed a full 400 pulls. In practice you <b>stop at the end of the block where the last student arrives</b>. Nobody spends another 200 pulls on a finished roster just to farm Eleph. Each exchange still goes to a student you do not own, whenever one remains.</p>',
  ],
  ['<h3>2PU（水着イロハ・水着イブキ）</h3>', '<h3>Two students (Swimsuit Iroha, Swimsuit Ibuki)</h3>'],
  ['<h3>3PU（水着イロハ・水着イブキ・制服ネル）</h3>', '<h3>Three students (Swimsuit Iroha, Swimsuit Ibuki, Uniform Nel)</h3>'],
  ['<th>進め方</th>', '<th>Approach</th>'],
  ['<th>期待消費</th>', '<th>Expected cost</th>'],
  ['<th>期待文字</th>', '<th>Expected Eleph</th>'],
  [
    '<p class="note">2PUでは進め方を変えても降りる時点は動きません。<b>約8割が200連で解放され、残る2割が400連の残業に回ります</b>。イロハに集中したほうが重複ぶんで8文字だけ多く残りますが、素体をそろえる速さは同じです。</p>',
    '<p class="note">With two students the approach does not change when you get to stop: <b>about 80% are released at 200 pulls and the remaining 20% face the 400-pull overtime</b>. Staying on Iroha leaves 8 more Eleph from duplicates, but assembles the roster at exactly the same speed.</p>',
  ],
  [
    '<p class="note">どちらの場合も期待文字は300前後にとどまります。イブキが素体確保で十分な性能なら、これで目的は果たせています。イブキにも固有2が要るなら<b>340文字には遠く届かず</b>、このガチャだけでは完結しません。</p>',
    '<p class="note">Either way the haul lands around 300 Eleph. If simply owning Ibuki is enough, the job is done. If Ibuki also needs UE2, that <b>falls well short of 340 Eleph</b> and this banner alone will not finish the job.</p>',
  ],
  [
    '<p class="note">3PUになると進め方で結果が割れます。引けたら次の生徒へ移れば<b>200連で降りられる確率が50.6%</b>まで上がり、期待消費は36,640石。イロハに集中すると200連での解放は25.7%に半減し、期待消費は44,477石へ膨らみます。そのかわり集中したほうが<b>76文字多く</b>持ち帰ります。</p>',
    '<p class="note">At three students the approaches split apart. Moving on after each hit raises the chance of stopping at 200 pulls to <b>50.6%</b> and costs 36,640 Pyroxene on average. Staying on Iroha halves that release rate to 25.7% and pushes the cost to 44,477 Pyroxene — but carries away <b>76 more Eleph</b>.</p>',
  ],
  [
    '<p class="note">7,837石を積んで76文字を買う取引だと言い換えられます。アタッカーの固有2を急ぐなら悪くありませんが、素体をそろえて次の募集へ石を残したいなら、素直に引けた順で乗り換えるほうが安く上がります。<b>この判断を先生が持てること自体が、呼出ポイントにしかない性質です。</b></p>',
    '<p class="note">Put another way, it buys 76 Eleph for 7,837 Pyroxene. That is a fair trade if an attacker needs UE2 soon, but if the goal is to own everyone and carry Pyroxene into the next banner, switching as each student lands is cheaper. <b>Having that call to make at all belongs to Recruitment Points alone.</b></p>',
  ],
  // 表のラベルは本文より後に置く。先に適用すると本文の一部を書き換えてしまう。
  ['イロハに集中', 'Stay on Iroha'],
  ['引けたら次の生徒へ', 'Move on after each hit'],
  ['体以上', '+'],
  ['イロハ', 'Iroha '],
  ['イブキ', 'Ibuki '],
  ['体</th>', '</th>'],
  ['<h2>凸のどこまで届くか</h2>', '<h2>How far up the upgrade track</h2>'],
  ['<th>到達段位</th>', '<th>Upgrade</th>'],
  ['<th>必要文字</th>', '<th>Eleph cost</th>'],
  [
    '<p class="note">3名を狙った場合に、対象3名分を合計した文字が段位のコストへ届く連数です。1名へ集中させた場合の数字ではありません。星3を出発点として星4に100文字、固有1にさらに120文字、固有2に120文字、固有3に180文字、固有4に200文字が必要です。</p>',
    '<p class="note">Pull counts at which the Eleph earned across all three targeted students reaches each cost. These are not the figures for funnelling everything into one student. Starting from 3★, reaching 5★ costs 100 Eleph, then UE1 a further 120, UE2 another 120, UE3 another 180, and UE4 another 200.</p>',
  ],
  ['＋', '+'],
  ['文字</td>', ' Eleph</td>'],
  ['>2名<', '>2 students<'],
  ['>3名<', '>3 students<'],
  ['>4名<', '>4 students<'],
  ['<th>星4</th>', '<th>5★</th>'],
  ['<th>固有1</th>', '<th>UE1</th>'],
  ['<th>固有2</th>', '<th>UE2</th>'],
  ['<th>固有3</th>', '<th>UE3</th>'],
  ['<th>固有4</th>', '<th>UE4</th>'],
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
  ['<th>差</th>', '<th>Gap</th>'],
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
  // 短い語は最後に。タグ境界を含めて誤爆を防ぐ。
  ['<small>素体</small>', '<small>owned</small>'],
  ['<small>ボーナス</small>', '<small>bonus</small>'],
  ['連</b>', ' pulls</b>'],
  ['連</td>', ' pulls</td>'],
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
    focus: thinGroup(result.focus),
  };
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
