// 日本語版フェス限ページの本文。文言の編集はこのファイルだけで完結する。
// 英語版は render/festival-en.js を直接編集する(自動同期はしない)。
const fs = require('node:fs');
const path = require('node:path');
const { pct, TARGETS, PYROXENE_PER_PULL, FES_BYPRODUCT_PER_PULL } = require('../festival-calc.js');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const FESTIVAL_TAB_JS = fs.readFileSync(path.join(ASSETS, 'festival-tabs.js'), 'utf8').trim();
const GITHUB_LINK = fs.readFileSync(path.join(ASSETS, 'github-link.html'), 'utf8').trim();

/** 呼び出しポイントが交換できる区切り。ここが意思決定の分岐点になる。 */
const TABLE_PULLS = { 2: [200, 400], 3: [200, 400, 600], 4: [400, 600, 800] };


const PU_TAB_NAMES = { 2: '2PU', 3: '3PU', 4: '4PU' };
const PU_TAB_LEAD = {
  2: '制服ネル・リオ所持済みのベテラン先生。新規2名（水着イロハ・水着イブキ）狙い。',
  3: '4周年以降開始、制服ネルかリオの片方をすり抜け確保済み。残り3名狙い。',
  4: '復刻の制服ネル・リオも未所持の新規先生。対象4名すべて狙い。',
};

/** 2PU専用。呼び出しポイントの機械的な流れと、200連時点の分岐だけを示す。 */
function pointBlock(result) {
  const b = result.twoPuBranch;
  const p = (v) => `${(v * 100).toFixed(1)}%`;
  return `<h3>呼び出しポイント</h3><p>機械的に水着イロハをPU対象に設定して200連。200連時点の結果だけで分岐。</p><table><colgroup><col style="width:40%"><col style="width:16%"><col style="width:44%"></colgroup><thead><tr><th>200連時点</th><th>確率</th><th>動き</th></tr></thead><tbody><tr><th>イロハ自引き＋イブキすり抜け</th><td data-label="確率">${p(b.bothArrived)}</td><td data-label="動き">完了。交換はイブキを選び200文字（重複100＋初回ボーナス100）</td></tr><tr><th>イロハ自引きのみ</th><td data-label="確率" class="best">${p(b.exchangeForPartner)}</td><td data-label="動き">交換でイブキ確保、完了</td></tr><tr><th>イブキすり抜けのみ</th><td data-label="確率">${p(b.exchangeForMain)}</td><td data-label="動き">交換でイロハ確保、完了</td></tr><tr><th>どちらも無し</th><td data-label="確率">${p(b.overtime)}</td><td data-label="動き">地獄の残業へ。イロハを引き続け、400連時点で不足分を交換（最悪イロハ・イブキを各1体交換）</td></tr></tbody></table><p class="note">残業中にイロハが出ても引き止めなし、400連まで回して不足分を交換。余った交換枠は初回ボーナス未消費のイブキなら200文字、消費済みなら重複100文字に充て、他生徒は登場させない。</p>
<h3>水着イブキへのPU切替はナシ</h3><p>イロハを引けた後にPU対象をイブキへ切り替えるプラン：期待文字が${Math.round(result.blockRun[2].focus.letters)}文字→${Math.round(result.blockRun[2].sequential.letters)}文字に減るだけで消費は同一。<b>ありえない。</b></p><p class="note">イロハ確保後に固有3の制服ネルへ切り替えれば期待+56文字だが、旧仕様は今後戻らないため、ニッチパターンとして対象外。</p>`;
}



// 結論表の直下に置く説明。2PUは残業の重さを、3PU以上は表の読み方を示す。
const CONCLUSION_NOTE = {
  2: '<p class="note"><b>約8割が200連で解放、残る2割は400連目開始という地獄の残業。</b></p>',
  3: '<p class="note">イロハ集中は文字とのバランスのため<b>400連まで機械的に引き切る</b>。引けたら次へは<b>200連早抜け狙いの生存戦略</b>——期待獲得文字を減らしてでも石を残す。</p>',
  4: '<p class="note">イロハ集中は文字とのバランスのため<b>600連まで機械的に引き切る</b>。引けたら次へは<b>早抜け狙いの生存戦略</b>——期待獲得文字を減らしてでも石を残す。</p>',
};

// 呼び出しチャージ節の表下に置く、狙い順の説明。
const RETREAT_NOTE = {
  2: '交換がなく、機械的に水着イロハ→水着イブキの順にPU対象へ設定して引き当てる。途中でイブキがすり抜けたら嬉しいが、固有2必須なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
  3: '交換がなく、機械的に水着イロハ→水着イブキ→制服ネルの順にPU対象へ設定して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
  4: '交換がなく、機械的に水着イロハ→水着イブキ→制服ネル→リオの順にPU対象へ設定して引き当てる。途中ですり抜けたら嬉しいが、固有2必須の生徒なら獲得文字が減って欠片のやりくりがシビア。その場合は追加PU狙いで期待値90連も視野。',
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
<h3>結論</h3>${verdictLines(result, target, withSpook)}<table><colgroup><col style="width:30%"><col style="width:16%"><col style="width:16%"><col style="width:19%"><col style="width:19%"></colgroup><thead><tr><th>仕様と進め方</th><th>確率</th><th>連数</th><th>石</th><th>獲得文字</th></tr></thead><tbody>${outcomeRows(result, target).join('')}</tbody></table>${CONCLUSION_NOTE[target]}${target === 2 ? '' : '<p class="note">実は水着イロハを引き続ける行為は、文字目的のPU募集よりも効率が悪い方法という事が判明した。</p>'}
<h3>呼び出しチャージ</h3><table><colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup><thead><tr><th>そろえ方</th><th>期待募集回数</th><th>獲得文字</th></tr></thead><tbody><tr><th>${target}PU期待値</th><td data-label="期待募集回数">${without.expectedPulls.toFixed(1)}連</td><td data-label="獲得文字" class="best">${Math.round(without.letters)}文字</td></tr><tr><th>すり抜け込</th><td data-label="期待募集回数" class="best">${withSpook.expectedPulls.toFixed(1)}連</td><td data-label="獲得文字">${Math.round(withSpook.letters)}文字</td></tr><tr><th>差</th><td data-label="期待募集回数">−${savedPulls.toFixed(1)}連</td><td data-label="獲得文字">−${Math.round(lostLetters)}文字</td></tr><tr><th>すり抜け率</th><td colspan="2" data-label="すり抜け率">${(withSpook.finishedViaSpook * 100).toFixed(2)}%</td></tr></tbody></table><p class="note">${RETREAT_NOTE[target]}</p>

${target === 2 ? pointBlock(result) : ''}</div>`;
  }).join('') + `<div data-pu-panel="bank" hidden><p>呼び出しチャージは募集種別ごとに引き継ぎ。フェス限で99連止めしておけば、<b>次の限定をチャージ99で開始できる</b>。PU対象は<b>素体所持・初回ボーナス未受領の生徒</b>（制服ネル等）に設定。引ければ重複100＋ボーナス100の200文字。</p><h3>カウンタは無駄にならない</h3><p>途中で出てもカウンタは<b>積み直し</b>。99連完走時の残カウンタ期待値は${result.banking.expectedCharge.toFixed(0)}、持ち込める短縮は平均<b>${result.banking.expectedSaving.toFixed(1)}連</b>。暴発で台無しにはならない。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>99連を回した結果</th><th>確率</th><th>次の募集での短縮</th></tr></thead><tbody><tr><th>一度も出ずカウンタ99</th><td data-label="確率">${pct(result.banking.survivalToBank)}</td><td data-label="次の募集での短縮" class="best">${result.banking.savedPulls.toFixed(1)}連</td></tr><tr><th>途中で出た（カウンタは積み直し）</th><td data-label="確率">${pct(result.banking.hitChance)}</td><td data-label="次の募集での短縮">平均${result.banking.savingWhenHit.toFixed(1)}連</td></tr><tr><th>ならして</th><td data-label="確率">—</td><td data-label="次の募集での短縮">${result.banking.expectedSaving.toFixed(1)}連</td></tr></tbody></table><h3>収支</h3><p>持ち出しは99連−短縮分の<b>${result.banking.carryPulls.toFixed(1)}連</b>（${stone(result.banking.carryPulls)}石）。フェス限掘り（補填込み）${result.banking.chaseRateFes.toFixed(2)}文字/連で換算して<b>${result.banking.costLetters.toFixed(0)}文字</b>の支出。対する受け取りは以下。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>受け取るもの</th><th>期待</th><th>文字換算</th></tr></thead><tbody><tr><th>PU対象の生徒（初回ボーナス込み）</th><td data-label="期待">${result.banking.expectedHits.toFixed(2)}体</td><td data-label="文字換算" class="best">${result.banking.lettersFromNamed.toFixed(0)}文字</td></tr><tr><th>欠片一括（フェス80欠片/10連）</th><td data-label="期待">${result.banking.fesShards.toFixed(0)}欠片</td><td data-label="文字換算">${result.banking.lettersFromFesShards.toFixed(0)}文字</td></tr><tr><th>フェス限9名プールの文字</th><td data-label="期待">${result.banking.poolHits.toFixed(2)}件</td><td data-label="文字換算">${result.banking.lettersFromPool.toFixed(0)}文字</td></tr><tr><th>恒常星3（参考・欠片は一括に含む）</th><td data-label="期待">+${result.banking.star3Net.toFixed(2)}体</td><td data-label="文字換算">—</td></tr><tr><th>合計</th><td data-label="期待">—</td><td data-label="文字換算" class="best">${result.banking.lettersTotal.toFixed(0)}文字</td></tr></tbody></table><p class="formula">支出 ${result.banking.costLetters.toFixed(0)}文字 ＜ 受け取り ${result.banking.lettersTotal.toFixed(0)}文字</p><p class="note">文字だけで支出を超過。星3と欠片は丸ごと上乗せ。<b>PU対象の生徒の文字を取り切りたい先生には得。</b></p><p class="note">同じ99連ならフェス限期間のほうが欠片約${result.shardYield.bankGain}枚多い。凸に回せる分に割り引けば${result.shardYield.bankGainLetters}文字程度、判断には影響なし。</p><h3>出たら即止め</h3><p class="note">出た後も99連まで回すと効率は約1.1文字/連に半減。<b>出た時点で止めれば</b>持ち出しは${result.banking.stopOnHitCost.toFixed(1)}連、素追いと同効率。</p><h3>向き・不向き</h3><ul class="rules"><li><b>得</b>：PU対象の生徒の文字を取り切りたい先生。素追いと同じ石効率にフェス限すり抜けが上乗せ。外しても次の限定で平均${result.banking.expectedSaving.toFixed(1)}連分返ってくる。</li><li><b>損</b>：文字の受け皿が無い先生。石で欠片と使わない星3を買うだけ。分かれ目はPU対象1体分の文字に使い道があるか。</li></ul></div>`;
  return `<section class="panel"><div class="tabs" role="tablist" aria-label="狙う人数">${tabs}</div><div id="pu-panel" role="tabpanel" aria-labelledby="tab-2pu">${panels}</div></section>`;
}

// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。
// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');

/** 200連ブロックごとの撤退確率。悲惨な残業がどれだけの確率で起きるかを見る。 */
/** 新旧をひとつの表に並べ、呼び出しポイントは降りたブロックごとに分けて示す。 */
/** 結論の判定行。石の節約と文字の減少を色分けし、浮いた連数の掘り換算を添える。 */
function verdictLines(result, target, withSpook) {
  // 文字目的の周回は平常時の10連50欠片で換算する。
  const rate = result.banking.chaseRate;
  const line = (plan, label) => {
    const saved = plan.pulls - withSpook.expectedPulls;
    // 旧仕様側は追加で引いたぶんフェス限の欠片(16文字/10連)も拾っている。
    const lost = (plan.letters - withSpook.letters) + saved * FES_BYPRODUCT_PER_PULL;
    const recovered = saved * rate;
    const verdict = recovered >= lost
      ? '<b class="gain">呼び出しチャージ優位</b>'
      : '<b class="loss">呼び出しポイント優位</b>';
    return `<p class="verdict">${label}呼び出しチャージは<b class="gain">${stone(saved)}石</b>安くなる代わりに<b class="loss">${Math.round(lost)}文字分減少</b>。<br>文字目的の周回 <u class="tip" tabindex="0" data-tip="${saved.toFixed(1)}連 * (5欠片 + 200文字 / 期待値90連)">${saved.toFixed(1)}連</u> → ${Math.round(recovered)}文字<br>${verdict}</p>`;
  };
  // イロハを引き続ける打ち方は悪手(効率の悪い文字周回)なので、結論の比較相手にしない。
  if (target === 2) return line(result.blockRun[2].focus, '');
  return line(result.blockRun[target].sequential, '');
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





function renderFestivalHtml(result) {
  const rates = result.rates;
  const banking = result.banking;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5フェス限の新旧比較</title><link rel="stylesheet" href="css/festival.css"></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5フェス限の新旧比較</h1>${GITHUB_LINK}</div><p class="lead">フェス限すり抜け確率が高いため、通常の募集と比べて変数が多い。5.5周年のフェス限ガチャの新旧比較検証を机上で行う。</p></header>
<section class="panel"><details><summary>計算に使う前提</summary><ul class="rules"><li>フェス限定募集の星3排出率 <b>${pct(rates.festivalStar3)}</b>。</li><li>PU対象1名の排出率 <b>${pct(rates.namedPu)}</b>。呼び出しチャージはチャージ99で50%、199で100%。</li><li>新旧フェス限10名−PU対象1名の<b>9名</b>で <b>${pct(rates.spookPoolTotal)}</b> を等分、1名 <b>${pct(rates.spookEach)}</b>。</li><li>初回PUボーナスは<b>PU対象の自引きと呼び出しポイント交換</b>のみ。すり抜けでは付かない。</li><li>10連募集を行う度に、50欠片（フェス限ガチャ80欠片）を獲得するものとする。</li></ul></details></section>
${retreatSection(result)}
<footer>Generated by scripts/festival.js</footer></main>
<script src="js/festival.js" defer></script></body></html>`;
}

module.exports = { renderBody: renderFestivalHtml };
