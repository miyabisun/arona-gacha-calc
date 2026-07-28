// 英語版・通常2PUページの本文。日本語版(render/pickup-ja.js)とは独立に編集する。
const fs = require('node:fs');
const path = require('node:path');
const { pct, PYROXENE_PER_PULL, EXCHANGE_PULLS, OVERTIME_LIMIT } = require('../pickup-calc.js');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const GITHUB_LINK = fs.readFileSync(path.join(ASSETS, 'github-link.html'), 'utf8').trim();

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');
const p1 = (value) => `${(value * 100).toFixed(1)}%`;

function verdictLine(result) {
  const { saved, lost, recovered, chargeWins } = result.verdict;
  const verdict = chargeWins
    ? '<b class="gain">Recruitment Charge wins</b>'
    : '<b class="loss">Recruitment Points wins</b>';
  return `<p class="verdict">Recruitment Charge saves <b class="gain">${stone(saved)} Pyroxene</b> at the cost of <b class="loss">${Math.round(lost)} Eleph</b>.<br>Eleph chase: <u class="tip" tabindex="0" data-tip="${saved.toFixed(1)} pulls * (5 shards + 200 Eleph / 90 expected pulls)">${saved.toFixed(1)} pulls</u> → ${Math.round(recovered)} Eleph<br>${verdict}</p>`;
}

function outcomeTable(result) {
  const charge = result.charge;
  const point = result.point;
  const overtimeTotal = EXCHANGE_PULLS + point.overtimePulls;
  const rows = [
    `<tr><th>Charge</th><td data-label="Chance">—</td><td data-label="Pulls">${charge.expectedPulls.toFixed(1)} pulls</td><td data-label="Pyroxene">${stone(charge.expectedPulls)}</td><td data-label="Eleph">${Math.round(charge.letters)} Eleph</td></tr>`,
    `<tr><th rowspan="4">Points</th><td data-label="Chance">${p1(point.branches.both)}</td><td data-label="Pulls">${EXCHANGE_PULLS} pulls</td><td data-label="Pyroxene">${stone(EXCHANGE_PULLS)}</td><td data-label="Eleph">${Math.round(point.lettersAt200.both)} Eleph</td></tr>`,
    `<tr><td data-label="Chance">${p1(point.branches.aOnly)}</td><td data-label="Pulls">${EXCHANGE_PULLS} pulls</td><td data-label="Pyroxene">${stone(EXCHANGE_PULLS)}</td><td data-label="Eleph">${Math.round(point.lettersAt200.aOnly)} Eleph</td></tr>`,
    `<tr><td data-label="Chance">${p1(point.branches.none)}</td><td data-label="Pulls">avg ${overtimeTotal.toFixed(1)} pulls</td><td data-label="Pyroxene">${stone(overtimeTotal)}</td><td data-label="Eleph">200 Eleph</td></tr>`,
    `<tr><td data-label="Chance">Overall</td><td data-label="Pulls">${point.expectedPulls.toFixed(1)} pulls</td><td data-label="Pyroxene">${stone(point.expectedPulls)}</td><td data-label="Eleph">${Math.round(point.letters)} Eleph</td></tr>`,
  ];
  return `<table><colgroup><col style="width:30%"><col style="width:16%"><col style="width:16%"><col style="width:19%"><col style="width:19%"></colgroup><thead><tr><th>System</th><th>Chance</th><th>Pulls</th><th>Pyroxene</th><th>Eleph earned</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function pointBlock(result) {
  const b = result.point.branches;
  return `<h3>Recruitment Points</h3><p>Select student A mechanically; the moment she lands, move to student B's banner. The branch depends only on where things stand at pull ${EXCHANGE_PULLS}.</p><table><colgroup><col style="width:40%"><col style="width:16%"><col style="width:44%"></colgroup><thead><tr><th>At pull ${EXCHANGE_PULLS}</th><th>Chance</th><th>Action</th></tr></thead><tbody><tr><th>Both pulled</th><td data-label="Chance">${p1(b.both)}</td><td data-label="Action">Done. Exchange goes to a duplicate for 100 Eleph</td></tr><tr><th>A pulled only</th><td data-label="Chance" class="best">${p1(b.aOnly)}</td><td data-label="Action">Exchange secures B, done</td></tr><tr><th>Neither</th><td data-label="Chance">${p1(b.none)}</td><td data-label="Action">Exchange secures A, then keep pulling B in overtime (avg +${result.point.overtimePulls.toFixed(0)} pulls; exchange B at pull ${OVERTIME_LIMIT} if she never lands)</td></tr></tbody></table><p class="note">Even with both in hand, the run completes all ${EXCHANGE_PULLS} pulls, rolling 0.7% duplicates (100 Eleph + 50 shards) along the way. Overtime ends the moment B lands.</p>`;
}

function renderPickupHtml(result) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Normal 2PU Comparison</title><link rel="stylesheet" href="../css/festival.css"></head><body><main><nav class="nav"><a href="./">確率表</a><a href="pickup.html" aria-current="page">通常2PU</a><a href="festival.html">5.5th</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>Normal 2PU Comparison</h1>${GITHUB_LINK}</div><p class="lead">Going after two students on normal pickup banners, where spooks cannot help. Pull A first, then B, and compare Recruitment Points against Recruitment Charge.</p></header>
<section class="panel"><details><summary>Assumptions</summary><ul class="rules"><li>Each PU student appears at <b>${pct(result.rates.pu)}</b>. Under Recruitment Charge that becomes 50% at charge 99 and 100% at charge 199.</li><li>No spook is expected: the 2.3% off-PU 3★ slice is split across 100+ students, so any single one is negligible.</li><li>Every ten-pull recruitment grants 50 shards.</li><li>The first-time pickup bonus is granted only by <b>pulling the selected student or exchanging Recruitment Points</b>.</li><li>Recruitment Points are shared across concurrent PU banners; ${EXCHANGE_PULLS}P exchanges any one student.</li><li>The moment A lands, move to B's banner.</li></ul></details></section>
<section class="panel"><h3>Verdict</h3>${verdictLine(result)}${outcomeTable(result)}<p class="note">Recruitment Points earns more Eleph because pulls and the exchange work independently — at the price of only being able to stop on ${EXCHANGE_PULLS}-pull boundaries.</p>
${pointBlock(result)}</section>
<footer>Generated by scripts/pickup.js</footer></main></body></html>`;
}

module.exports = { renderBody: renderPickupHtml };
