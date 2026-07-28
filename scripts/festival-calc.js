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
// 10連価値ルールから導く、1連あたりの欠片の文字換算。
// 平常時: 10連=50欠片(≒10文字) → 1.0文字/連 / フェス限: 10連=80欠片(≒16文字) → 1.6文字/連
const NORMAL_BYPRODUCT_PER_PULL = SHARDS_PER_TEN_NORMAL / 10 / SHARD_TAIL_RATE;
const FES_BYPRODUCT_PER_PULL = SHARDS_PER_TEN_FESTIVAL / 10 / SHARD_TAIL_RATE;
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
    // イロハ連打は文字とのバランスのため、(人数-1)ブロックまでは揃っていても機械的に引き切る。
    // PU切替は早抜け狙いの生存戦略なので、揃ったブロックで即降りる。
    const mayStop = focus ? block >= targets - 1 : true;
    for (const [key, cell] of states) {
      const [main, pu, spook] = key.split(':').map(Number);
      if (mayStop && main >= 1 && pu + spook >= others) { finished += cell.mass; finishedLetters += cell.letters; }
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
  // 補填込みの掘り効率。星3の欠片ぶんを上乗せする(ボーナス未取得のフェス限が残る先生は更に得だが、
  // できない先生もいるため新仕様不利側=この保守値を採用)。
  banking.chaseRate = banking.lettersPerPull + NORMAL_BYPRODUCT_PER_PULL;
  // 掘り先をフェス限期間に置けるなら、欠片補填も16文字/10連になる。
  banking.chaseRateFes = banking.lettersPerPull + FES_BYPRODUCT_PER_PULL;
  banking.costLetters = banking.carryPulls * banking.chaseRateFes;
  banking.star3Net = banking.star3Gained - banking.star3Forgone;
  // フェス限の欠片は10連=80欠片ルールで一括計上(星3重複の50欠片等を含むどんぶり値)。
  banking.fesShards = BANK_PULLS * (SHARDS_PER_TEN_FESTIVAL / 10);
  banking.lettersFromFesShards = BANK_PULLS * FES_BYPRODUCT_PER_PULL;
  banking.lettersTotal = banking.lettersFromNamed + banking.lettersFromPool + banking.lettersFromFesShards;
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

module.exports = {
  calculateFestival,
  runFestivalDp,
  runRetreat,
  runFocusExchange,
  runBlockRun,
  chargeHitRate,
  chargeResidual,
  shardsToLetters,
  effectiveLetters,
  expectedPulls,
  percentilePull,
  pct,
  SPOOK_EACH_RATE,
  MAX_PULLS,
  TARGETS,
  PYROXENE_PER_PULL,
  FES_BYPRODUCT_PER_PULL,
  NORMAL_BYPRODUCT_PER_PULL,
};
