#!/usr/bin/env node

/**
 * 通常ピックアップ(すり抜けなし)で2PUを狙う厳密計算。
 *
 * フェス限と違い、相方が別募集からすり抜けてくる期待はない(非PU星3 2.3%を
 * 100名超で頭割りするため)。本命A→相方Bの順にPU対象の募集を引き、
 * Aを引けたら即Bへ移る運用で、旧仕様(呼び出しポイント)と新仕様(呼び出しチャージ)を比べる。
 */

const PU_RATE = 0.007;
const PYROXENE_PER_PULL = 120;
// 10連50欠片、5欠片=1文字 → 1.0文字/連
const SHARDS_PER_TEN = 50;
const BYPRODUCT_PER_PULL = SHARDS_PER_TEN / 10 / 5;
const BONUS_LETTERS = 100;
const DUPLICATE_LETTERS = 100;
const DUPLICATE_SHARDS = 50;
const EXCHANGE_PULLS = 200;
const OVERTIME_LIMIT = 400;

/** 呼び出しチャージ下で1人を引き当てるまでの連数分布(1..200連)。 */
function chargeDistribution() {
  const dist = Array(201).fill(0);
  let alive = 1;
  for (let pull = 1; pull <= 200; pull += 1) {
    const charge = pull - 1;
    const hit = charge === 99 ? 0.5 : charge === 199 ? 1 : PU_RATE;
    dist[pull] = alive * hit;
    alive *= 1 - hit;
  }
  return dist;
}

const expectation = (dist) => dist.reduce((sum, mass, pull) => sum + mass * pull, 0);

/** 新仕様: A・Bを順に引く。チャージは引いた時点で0に戻るので単純に2倍。 */
function calculateChargePlan() {
  const single = chargeDistribution();
  const perStudent = expectation(single);
  return {
    expectedPullsPerStudent: perStudent,
    expectedPulls: perStudent * 2,
    letters: BONUS_LETTERS * 2,
  };
}

/**
 * 旧仕様: Aを引けたら即Bへ。200連時点で不足分(いなければ重複)を交換し、
 * どちらも出ていなければAを交換してBの残業へ(400連時点でBを交換する保険付き)。
 * 両者確保後も200連までは回し切るので、その間は0.7%で重複抽選が走る。
 */
function calculatePointPlan() {
  const q = 1 - PU_RATE;
  const noneAt200 = q ** EXCHANGE_PULLS;

  let bothAt200 = 0;
  let duplicatePulls = 0; // 両者確保後、200連まで回す残り連数の期待値(確率質量込み)
  for (let aHitPull = 1; aHitPull < EXCHANGE_PULLS; aHitPull += 1) {
    const aMass = q ** (aHitPull - 1) * PU_RATE;
    const bWindow = EXCHANGE_PULLS - aHitPull;
    bothAt200 += aMass * (1 - q ** bWindow);
    for (let bPulls = 1; bPulls <= bWindow; bPulls += 1) {
      duplicatePulls += aMass * q ** (bPulls - 1) * PU_RATE * (bWindow - bPulls);
    }
  }
  const aOnlyAt200 = 1 - noneAt200 - bothAt200;

  // 残業: Bを引くまで(最長400連、届かなければ交換)。期待連数は E[min(T,200)]。
  const overtimeWindow = OVERTIME_LIMIT - EXCHANGE_PULLS;
  const overtimePulls = (1 - q ** overtimeWindow) / PU_RATE;

  const duplicateLetters = duplicatePulls * PU_RATE * DUPLICATE_LETTERS;
  const duplicateShards = duplicatePulls * PU_RATE * DUPLICATE_SHARDS;

  const expectedPulls = EXCHANGE_PULLS * (1 - noneAt200)
    + (EXCHANGE_PULLS + overtimePulls) * noneAt200;
  // 全経路でA・Bのボーナス200文字。両者自引きなら交換枠が重複に回り+100。
  const letters = BONUS_LETTERS * 2 + DUPLICATE_LETTERS * bothAt200 + duplicateLetters;

  return {
    branches: {
      both: bothAt200,
      aOnly: aOnlyAt200,
      none: noneAt200,
    },
    lettersAt200: {
      // 200連で降りる2経路の平均獲得文字(表の200連行に使う)
      both: BONUS_LETTERS * 2 + DUPLICATE_LETTERS + duplicateLetters / (bothAt200 || 1),
      aOnly: BONUS_LETTERS * 2,
    },
    overtimePulls,
    duplicateLetters,
    duplicateShards,
    expectedPulls,
    letters,
  };
}

function calculatePickup() {
  const charge = calculateChargePlan();
  const point = calculatePointPlan();

  // 文字目的の周回: ボーナス未取得のPUをチャージで引く。200文字/期待値90連+欠片1文字/連。
  const chaseRate = BONUS_LETTERS * 2 / charge.expectedPullsPerStudent + BYPRODUCT_PER_PULL;

  const saved = point.expectedPulls - charge.expectedPulls;
  // 旧仕様側は追加で引いたぶん欠片(10連50枚)も拾っている。
  const lost = (point.letters - charge.letters) + saved * BYPRODUCT_PER_PULL;
  const recovered = saved * chaseRate;

  // 独立検算: 幾何分布2本の畳み込みで200連以内に両者を自引きする確率。
  let convolutionBoth = 0;
  const q = 1 - PU_RATE;
  for (let total = 2; total <= EXCHANGE_PULLS; total += 1) {
    // A=i連目・B=total-i連目 → q^(total-2)p^2 が (total-1) 通り
    convolutionBoth += (total - 1) * q ** (total - 2) * PU_RATE ** 2;
  }

  return {
    rates: { pu: PU_RATE, byproductPerPull: BYPRODUCT_PER_PULL },
    charge,
    point,
    verdict: { saved, lost, recovered, chargeWins: recovered >= lost, chaseRate },
    audit: {
      branchMassError: Math.abs(point.branches.both + point.branches.aOnly + point.branches.none - 1),
      convolutionBoth,
      convolutionGap: Math.abs(convolutionBoth - point.branches.both),
    },
  };
}

const pct = (value) => `${(value * 100).toFixed(2)}%`;

module.exports = {
  calculatePickup,
  chargeDistribution,
  pct,
  PU_RATE,
  PYROXENE_PER_PULL,
  BYPRODUCT_PER_PULL,
  EXCHANGE_PULLS,
  OVERTIME_LIMIT,
};
