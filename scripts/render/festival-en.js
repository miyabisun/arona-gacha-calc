// 英語版フェス限ページの本文。文言の編集はこのファイルだけで完結する。
// 日本語版は render/festival-ja.js。両言語の自動同期はしない(意図的)。
const fs = require('node:fs');
const path = require('node:path');
const { pct, TARGETS, PYROXENE_PER_PULL, FES_BYPRODUCT_PER_PULL } = require('../festival-calc.js');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const FESTIVAL_TAB_JS = fs.readFileSync(path.join(ASSETS, 'festival-tabs.js'), 'utf8').trim();
const GITHUB_LINK = fs.readFileSync(path.join(ASSETS, 'github-link.html'), 'utf8').trim()
  .replace('GitHubリポジトリを開く', 'Open the GitHub repository');

/** 呼び出しポイントが交換できる区切り。ここが意思決定の分岐点になる。 */
const TABLE_PULLS = { 2: [200, 400], 3: [200, 400, 600], 4: [400, 600, 800] };


const PU_TAB_NAMES = { 2: '2PU', 3: '3PU', 4: '4PU' };
const PU_TAB_LEAD = {
  2: 'A veteran already holding Uniform Nel and Rio, going after the two new students (Swimsuit Iroha and Swimsuit Ibuki).',
  3: 'A player who started after the 4th anniversary and picked up Nel or Rio off-banner, going after the other three.',
  4: 'A brand-new player who owns neither of the rerun pair, going after all four featured students.',
};

/** 2PU専用。呼び出しポイントの機械的な流れと、200連時点の分岐だけを示す。 */
function pointBlock(result) {
  const b = result.twoPuBranch;
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  return `<h3>Recruitment Points</h3><p>Select Swimsuit Iroha for 200 pulls, mechanically. The branch depends only on where things stand at pull 200.</p><table><colgroup><col style="width:40%"><col style="width:16%"><col style="width:44%"></colgroup><thead><tr><th>At pull 200</th><th>Chance</th><th>Action</th></tr></thead><tbody><tr><th>Iroha pulled + Ibuki spooked</th><td data-label="Chance">${p(b.bothArrived)}</td><td data-label="Action">Done. Exchange goes spare: 100 Eleph as a duplicate of either</td></tr><tr><th>Iroha pulled only</th><td data-label="Chance" class="best">${p(b.exchangeForPartner)}</td><td data-label="Action">Exchange secures Ibuki, done</td></tr><tr><th>Ibuki spooked only</th><td data-label="Chance">${p(b.exchangeForMain)}</td><td data-label="Action">Exchange secures Iroha, done</td></tr><tr><th>Neither</th><td data-label="Chance">${p(b.overtime)}</td><td data-label="Action">Overtime from hell. Keep pulling Iroha; at 400 exchange whatever is missing (worst case, one Iroha and one Ibuki)</td></tr></tbody></table><p class="note">An Iroha landing mid-overtime changes nothing: pull to 400 and exchange what is missing. Spare exchanges go to Iroha or Ibuki duplicates at 100 Eleph — no other student enters the story.</p>
<h3>Never switch the pickup to Ibuki</h3><p>The plan that switches the pickup to Ibuki once Iroha lands: expected Eleph drops from ${Math.round(result.blockRun[2].focus.letters)} to ${Math.round(result.blockRun[2].sequential.letters)} at identical cost. <b>Out of the question.</b></p><p class="note">Switching to a UE3 Uniform Nel after Iroha would add an expected +56 Eleph, but the old system is never coming back — a niche pattern, out of scope.</p>`;
}



// 結論表の直下に置く説明。2PUは残業の重さを、3PU以上は表の読み方を示す。
const CONCLUSION_NOTE = {
  2: '<p class="note"><b>About 80% are released at 200 pulls; the remaining 20% begin pull 401 — overtime from hell.</b></p>',
  3: '<p class="note">Staying on Iroha runs <b>mechanically to 400 pulls</b> for the Eleph balance. Moving on plays for the <b>200-pull early exit — a survival strategy</b> that trades expected Eleph for stones kept toward tomorrow\'s banner.</p>',
  4: '<p class="note">Staying on Iroha runs <b>mechanically to 600 pulls</b> for the Eleph balance. Moving on plays for the <b>early exit — a survival strategy</b> that trades expected Eleph for stones kept toward tomorrow\'s banner.</p>',
};

// 呼び出しチャージ節の表下に置く、狙い順の説明。
const RETREAT_NOTE = {
  2: 'There is no exchange: you select Swimsuit Iroha, then Swimsuit Ibuki, mechanically in order. An off-banner Ibuki along the way is welcome — but if she needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
  3: 'There is no exchange: you select Swimsuit Iroha, Swimsuit Ibuki, then Uniform Nel, mechanically in order. Off-banner arrivals along the way are welcome — but for a student who needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
  4: 'There is no exchange: you select Swimsuit Iroha, Swimsuit Ibuki, Uniform Nel, then Rio, mechanically in order. Off-banner arrivals along the way are welcome — but for a student who needs UE2, the Eleph haul shrinks and the shard budget gets tight. In that case an extra pickup chase, expecting about 90 pulls, comes into view.',
};


function retreatSection(result) {
  const tabs = [...TARGETS.map((target) => `<button type="button" role="tab" id="tab-${target}pu" aria-controls="pu-panel" aria-selected="${target === 2}" tabindex="${target === 2 ? 0 : -1}" data-pu="${target}">${PU_TAB_NAMES[target]}</button>`),
    '<button type="button" role="tab" id="tab-bankpu" aria-controls="pu-panel" aria-selected="false" tabindex="-1" data-pu="bank">Banking</button>'].join('');
  const panels = TARGETS.map((target) => {
    const withSpook = result.retreat[target].withSpook;
    const without = result.retreat[target].withoutSpook;
    const savedPulls = without.expectedPulls - withSpook.expectedPulls;
    const lostLetters = without.letters - withSpook.letters;
    const charge = result.scenarios.charge[target].expectedPullsToAllBase;
    const point = result.scenarios.point[target].expectedPullsToAllBase;
    return `<div data-pu-panel="${target}"${target === 2 ? '' : ' hidden'}><p>${PU_TAB_LEAD[target]}</p>
<h3>Verdict</h3>${verdictLines(result, target, withSpook)}<table><colgroup><col style="width:30%"><col style="width:16%"><col style="width:16%"><col style="width:19%"><col style="width:19%"></colgroup><thead><tr><th>System and approach</th><th>Chance</th><th>Pulls</th><th>Pyroxene</th><th>Eleph earned</th></tr></thead><tbody>${outcomeRows(result, target).join('')}</tbody></table>${CONCLUSION_NOTE[target]}${target === 2 ? '' : '<p class="note">As it turns out, continuing to pull for Swimsuit Iroha is simply a less efficient way to farm Eleph than a letter-chase PU banner.</p>'}
<h3>Recruitment Charge</h3><table><colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup><thead><tr><th>How they arrive</th><th>Expected pulls</th><th>Eleph earned</th></tr></thead><tbody><tr><th>${target}PU expected</th><td data-label="Expected pulls">${without.expectedPulls.toFixed(1)} pulls</td><td data-label="Eleph earned" class="best">${Math.round(without.letters)} Eleph</td></tr><tr><th>With spooks</th><td data-label="Expected pulls" class="best">${withSpook.expectedPulls.toFixed(1)} pulls</td><td data-label="Eleph earned">${Math.round(withSpook.letters)} Eleph</td></tr><tr><th>Gap</th><td data-label="Expected pulls">−${savedPulls.toFixed(1)} pulls</td><td data-label="Eleph earned">−${Math.round(lostLetters)} Eleph</td></tr><tr><th>Spook rate</th><td colspan="2" data-label="Spook rate">${(withSpook.finishedViaSpook * 100).toFixed(2)}%</td></tr></tbody></table><p class="note">${RETREAT_NOTE[target]}</p>

${target === 2 ? pointBlock(result) : ''}</div>`;
  }).join('') + `<div data-pu-panel="bank" hidden><p>Recruitment Charge carries over within a banner category, so stopping at 99 pulls on the festival banner means <b>the next limited banner opens at charge 99</b>. The student you select here is <b>one you already own whose first-time bonus is still unspent</b> — Uniform Nel, for instance. Hitting her pays 100 Eleph for the duplicate plus the 100 Eleph bonus: 200 in one go.</p><h3>The counter is never wasted</h3><p>Hitting the selected student inside those 99 pulls resets the counter to 0, but <b>every miss after that starts stacking again</b>. The counter left in hand once 99 pulls are done averages ${result.banking.expectedCharge.toFixed(0)}, and the shortening carried into the next banner averages <b>${result.banking.expectedSaving.toFixed(1)} pulls</b>. An early hit does not throw the plan away.</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>After 99 pulls</th><th>Chance</th><th>Shortening carried</th></tr></thead><tbody><tr><th>No hit, counter at 99</th><td data-label="Chance">${pct(result.banking.survivalToBank)}</td><td data-label="Shortening carried" class="best">${result.banking.savedPulls.toFixed(1)} pulls</td></tr><tr><th>Hit along the way (counter rebuilt)</th><td data-label="Chance">${pct(result.banking.hitChance)}</td><td data-label="Shortening carried">avg ${result.banking.savingWhenHit.toFixed(1)} pulls</td></tr><tr><th>Overall</th><td data-label="Chance">—</td><td data-label="Shortening carried">${result.banking.expectedSaving.toFixed(1)} pulls</td></tr></tbody></table><h3>The ledger</h3><p>Netting the shortening out of 99 pulls leaves an outlay of <b>${result.banking.carryPulls.toFixed(1)} pulls</b> (${stone(result.banking.carryPulls)} Pyroxene). The festival-period chase runs at ${result.banking.chaseRateFes.toFixed(2)} Eleph per pull, so in Eleph that is <b>${result.banking.costLetters.toFixed(0)} Eleph</b> spent. Here is what comes back.</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>Received</th><th>Expected</th><th>In Eleph</th></tr></thead><tbody><tr><th>Selected student (bonus included)</th><td data-label="Expected">${result.banking.expectedHits.toFixed(2)}</td><td data-label="In Eleph" class="best">${result.banking.lettersFromNamed.toFixed(0)} Eleph</td></tr><tr><th>Shards, lump sum (80 per 10 festival pulls)</th><td data-label="Expected">${result.banking.fesShards.toFixed(0)} shards</td><td data-label="In Eleph">${result.banking.lettersFromFesShards.toFixed(0)} Eleph</td></tr><tr><th>Eleph from the nine-student pool</th><td data-label="Expected">${result.banking.poolHits.toFixed(2)}</td><td data-label="In Eleph">${result.banking.lettersFromPool.toFixed(0)} Eleph</td></tr><tr><th>Permanent 3★ (reference; shards in the lump)</th><td data-label="Expected">+${result.banking.star3Net.toFixed(2)}</td><td data-label="In Eleph">—</td></tr><tr><th>Total</th><td data-label="Expected">—</td><td data-label="In Eleph" class="best">${result.banking.lettersTotal.toFixed(0)} Eleph</td></tr></tbody></table><p class="formula">Spent ${result.banking.costLetters.toFixed(0)} Eleph < received ${result.banking.lettersTotal.toFixed(0)} Eleph</p><p class="note">Eleph alone already clears the bar, with the 3★ students and shards stacked on top. <b>For anyone still collecting Eleph on the selected student, this plan pays.</b></p><p class="note">The same 99 pulls inside the festival, where 3★ runs at double, also leave about ${result.shardYield.bankGain} more shards. Discounted to what actually reaches a build that is roughly ${result.shardYield.bankGainLetters} Eleph — not enough to sway the decision.</p><h3>But stop the moment she arrives</h3><p class="note">Carrying on to 99 pulls after the hit drops the efficiency of those extra pulls to about 1.1 Eleph each. <b>Stop when she lands</b> and the outlay settles at exactly ${result.banking.stopOnHitCost.toFixed(1)} pulls — the same efficiency as chasing her outright.</p><h3>Who this suits</h3><ul class="rules"><li><b>Worth it</b> if you still want Eleph on the selected student. The Pyroxene efficiency matches chasing her outright, with festival off-target pulls added on top. Even a miss returns an average of ${result.banking.expectedSaving.toFixed(1)} pulls on the next limited banner.</li><li><b>Not worth it</b> if there is nowhere left to spend Eleph. You are buying shards and 3★ students you will never build. The line is simply whether one student's worth of Eleph still has a use.</li></ul></div>`;
  return `<section class="panel"><h2>Pick your target count</h2><p>The answer depends on the target count. Each tab holds everything for that count, cost through exit.</p><div class="tabs" role="tablist" aria-label="Number of students targeted">${tabs}</div><div id="pu-panel" role="tabpanel" aria-labelledby="tab-2pu">${panels}</div></section>`;
}

// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。
// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');

/** 200連ブロックごとの撤退確率。悲惨な残業がどれだけの確率で起きるかを見る。 */
/** 新旧をひとつの表に並べ、呼び出しポイントは降りたブロックごとに分けて示す。 */
/** 結論の判定行。石の節約と文字の減少を色分けし、浮いた連数の掘り換算を添える。 */
function verdictLines(result, target, withSpook) {
  const rate = result.banking.chaseRateFes;
  const line = (plan, label) => {
    const saved = plan.pulls - withSpook.expectedPulls;
    // 旧仕様側は追加で引いたぶんフェス限の欠片(16文字/10連)も拾っている。
    const lost = (plan.letters - withSpook.letters) + saved * FES_BYPRODUCT_PER_PULL;
    const recovered = saved * rate;
    return `<p class="verdict">${label}Recruitment Charge saves <b class="gain">${stone(saved)} Pyroxene</b> at the cost of <b class="loss">${Math.round(lost)} Eleph</b>.<br>Eleph chase: <u class="tip" tabindex="0" data-tip="${saved.toFixed(1)} pulls * 80 shards / 5 Eleph + 200 Eleph / 90 expected pulls">${saved.toFixed(1)} pulls</u> → ${Math.round(recovered)} Eleph<br><b class="loss">Recruitment Points wins</b></p>`;
  };
  // イロハを引き続ける打ち方は悪手(効率の悪い文字周回)なので、結論の比較相手にしない。
  if (target === 2) return line(result.blockRun[2].focus, '');
  return line(result.blockRun[target].sequential, '');
}

function outcomeRows(result, targets) {
  const charge = result.retreat[targets].withSpook;
  const rows = [`<tr><th>Recruitment Charge</th><td data-label="Chance">—</td><td data-label="Pulls">${charge.expectedPulls.toFixed(1)} pulls</td><td data-label="Pyroxene">${stone(charge.expectedPulls)} Pyroxene</td><td data-label="Eleph earned">${Math.round(charge.letters)} Eleph</td></tr>`];
  // 2PUは進め方による差が数文字しかないので、イロハ集中の1系統だけ載せる。
  const plansToShow = targets === 2
    ? [['focus', 'Recruitment Points']]
    : [['sequential', 'Recruitment Points, moving on'], ['focus', 'Recruitment Points, staying on Iroha']];
  for (const [id, label] of plansToShow) {
    const plan = result.blockRun[targets][id];
    plan.blocks.filter((block) => block.stopHere > 0.001).forEach((block, index) => {
      const head = index === 0 ? `<th rowspan="${plan.blocks.filter((b) => b.stopHere > 0.001).length + 1}">${label}</th>` : '';
      rows.push(`<tr>${head}<td data-label="Chance">${(block.stopHere * 100).toFixed(1)}%</td><td data-label="Pulls">${block.pulls} pulls</td><td data-label="Pyroxene">${(block.pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP')} Pyroxene</td><td data-label="Eleph earned">${Math.round(block.lettersHere)} Eleph</td></tr>`);
    });
    rows.push(`<tr><td data-label="Chance">Overall</td><td data-label="Pulls">${plan.pulls.toFixed(1)} pulls</td><td data-label="Pyroxene">${stone(plan.pulls)} Pyroxene</td><td data-label="Eleph earned">${Math.round(plan.letters)} Eleph</td></tr>`);
  }
  return rows;
}

/** 差がある場合だけ有利な側へ印を付ける。到達率は高い方、期待回数は少ない方が有利。 */
function better(value, rival, preferHigh) {
  const wins = preferHigh ? value > rival + 1e-9 : value < rival - 1e-9;
  return wins ? ' class="best"' : '';
}





function renderFestivalHtml(result) {
  const rates = result.rates;
  const banking = result.banking;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5th Anniversary Festival Comparison</title><link rel="stylesheet" href="../css/festival.css"></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5th Anniversary Festival Comparison</h1>${GITHUB_LINK}</div><p class="lead">Festival spooks are frequent, adding variables normal banners lack. A desk-side check of the 5.5th-anniversary festival banner: old spec versus new.</p></header>
<section class="panel"><details><summary>Assumptions</summary><ul class="rules"><li>The 3★ rate during festival recruitment is <b>${pct(rates.festivalStar3)}</b>.</li><li>The student you select appears at <b>${pct(rates.namedPu)}</b>. Under Recruitment Charge, that becomes 50% at charge 99 and 100% at charge 199.</li><li>The <b>9</b> remaining festival students — 10 in total, minus the one you selected — share <b>${pct(rates.spookPoolTotal)}</b> equally, giving <b>${pct(rates.spookEach)}</b> each.</li><li>The first-time pickup bonus is granted only by <b>pulling the student you selected or exchanging Recruitment Points</b>. An off-target pull never grants it.</li><li>Every ten-pull recruitment grants 50 shards (80 on festival banners).</li></ul></details></section>
${retreatSection(result)}
<footer>Generated by scripts/festival.js</footer></main>
<script src="../js/festival.js" defer></script></body></html>`;
}

module.exports = { renderBody: renderFestivalHtml };
