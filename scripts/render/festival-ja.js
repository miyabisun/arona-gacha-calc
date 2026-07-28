// 日本語版フェス限ページの本文。文言の編集はこのファイルだけで完結する。
// 英語版は render/festival-en.js を直接編集する(自動同期はしない)。
const fs = require('node:fs');
const path = require('node:path');
const { pct, TARGETS, PYROXENE_PER_PULL, FES_BYPRODUCT_PER_PULL } = require('../festival-calc.js');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const FESTIVAL_TAB_JS = fs.readFileSync(path.join(ASSETS, 'festival-tabs.js'), 'utf8').trim();
const GITHUB_LINK = fs.readFileSync(path.join(ASSETS, 'github-link.html'), 'utf8').trim();

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



// 結論表の直下に置く説明。2PUは残業の重さを、3PU以上は表の読み方を示す。
const CONCLUSION_NOTE = {
  2: '<p class="note">呼出ポイントは200連単位でしか降りられない。<b>約8割が200連で解放、残る2割は400連目開始という地獄の残業。</b></p>',
  3: '<p class="note">イロハ集中は文字とのバランスのため<b>400連まで機械的に引き切る</b>。引けたら次へは<b>200連早抜け狙いの生存戦略</b>——期待獲得文字を減らしてでも石を残す。</p>',
  4: '<p class="note">イロハ集中は文字とのバランスのため<b>600連まで機械的に引き切る</b>。引けたら次へは<b>早抜け狙いの生存戦略</b>——期待獲得文字を減らしてでも石を残す。</p>',
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
  }).join('') + `<div data-pu-panel="bank" hidden><p>呼出チャージは募集種別ごとに引き継ぎ。フェス限で99連止めしておけば、<b>次の限定をチャージ99で開始できる</b>。指名は<b>素体所持・初回ボーナス未受領の生徒</b>（制服ネル等）。引ければ重複100＋ボーナス100の200文字。</p><h3>カウンタは無駄にならない</h3><p>途中で出てもカウンタは<b>積み直し</b>。99連完走時の残カウンタ期待値は${result.banking.expectedCharge.toFixed(0)}、持ち込める短縮は平均<b>${result.banking.expectedSaving.toFixed(1)}連</b>。暴発で台無しにはならない。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>99連を回した結果</th><th>確率</th><th>次の募集での短縮</th></tr></thead><tbody><tr><th>一度も出ずカウンタ99</th><td data-label="確率">${pct(result.banking.survivalToBank)}</td><td data-label="次の募集での短縮" class="best">${result.banking.savedPulls.toFixed(1)}連</td></tr><tr><th>途中で出た（カウンタは積み直し）</th><td data-label="確率">${pct(result.banking.hitChance)}</td><td data-label="次の募集での短縮">平均${result.banking.savingWhenHit.toFixed(1)}連</td></tr><tr><th>ならして</th><td data-label="確率">—</td><td data-label="次の募集での短縮">${result.banking.expectedSaving.toFixed(1)}連</td></tr></tbody></table><h3>収支</h3><p>持ち出しは99連−短縮分の<b>${result.banking.carryPulls.toFixed(1)}連</b>（${stone(result.banking.carryPulls)}石）。フェス限掘り（補填込み）${result.banking.chaseRateFes.toFixed(2)}文字/連で換算して<b>${result.banking.costLetters.toFixed(0)}文字</b>の支出。対する受け取りは以下。</p><table><colgroup><col style="width:46%"><col style="width:27%"><col style="width:27%"></colgroup><thead><tr><th>受け取るもの</th><th>期待</th><th>文字換算</th></tr></thead><tbody><tr><th>指名生徒（初回ボーナス込み）</th><td data-label="期待">${result.banking.expectedHits.toFixed(2)}体</td><td data-label="文字換算" class="best">${result.banking.lettersFromNamed.toFixed(0)}文字</td></tr><tr><th>欠片一括（フェス80欠片/10連）</th><td data-label="期待">${result.banking.fesShards.toFixed(0)}欠片</td><td data-label="文字換算">${result.banking.lettersFromFesShards.toFixed(0)}文字</td></tr><tr><th>フェス限9名プールの文字</th><td data-label="期待">${result.banking.poolHits.toFixed(2)}件</td><td data-label="文字換算">${result.banking.lettersFromPool.toFixed(0)}文字</td></tr><tr><th>恒常星3（参考・欠片は一括に含む）</th><td data-label="期待">+${result.banking.star3Net.toFixed(2)}体</td><td data-label="文字換算">—</td></tr><tr><th>合計</th><td data-label="期待">—</td><td data-label="文字換算" class="best">${result.banking.lettersTotal.toFixed(0)}文字</td></tr></tbody></table><p class="formula">支出 ${result.banking.costLetters.toFixed(0)}文字 ＜ 受け取り ${result.banking.lettersTotal.toFixed(0)}文字</p><p class="note">文字だけで支出を超過。星3と欠片は丸ごと上乗せ。<b>指名生徒の文字を取り切りたい先生には得。</b></p><p class="note">同じ99連ならフェス限期間のほうが欠片約${result.shardYield.bankGain}枚多い。凸に回せる分に割り引けば${result.shardYield.bankGainLetters}文字程度、判断には影響なし。</p><h3>出たら即止め</h3><p class="note">出た後も99連まで回すと効率は約1.1文字/連に半減。<b>出た時点で止めれば</b>持ち出しは${result.banking.stopOnHitCost.toFixed(1)}連、素追いと同効率。</p><h3>向き・不向き</h3><ul class="rules"><li><b>得</b>：指名生徒の文字を取り切りたい先生。素追いと同じ石効率にフェス限すり抜けが上乗せ。外しても次の限定で平均${result.banking.expectedSaving.toFixed(1)}連分返ってくる。</li><li><b>損</b>：文字の受け皿が無い先生。石で欠片と使わない星3を買うだけ。分かれ目は指名生徒1体分の文字に使い道があるか。</li></ul></div>`;
  return `<section class="panel"><h2>狙う人数で選ぶ</h2><p>結論は狙う人数で変わる。該当するタブに、費用から降りどきまでを集約。</p><div class="tabs" role="tablist" aria-label="狙う人数">${tabs}</div><div id="pu-panel" role="tabpanel" aria-labelledby="tab-2pu">${panels}</div></section>`;
}

// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。
// フェス限を取り逃す選択肢は攻略上あり得ないので、1枠目は必ず相方の確保に使う。

const stone = (pulls) => Math.round(pulls * PYROXENE_PER_PULL).toLocaleString('ja-JP');

/** 200連ブロックごとの撤退確率。悲惨な残業がどれだけの確率で起きるかを見る。 */
/** 新旧をひとつの表に並べ、呼出ポイントは降りたブロックごとに分けて示す。 */
/** 結論の判定行。旧仕様側の進め方ごとに、浮いた石の掘り返しをぶつけて優位を一意に決める。 */
/** ページ末尾の総括。連打信仰の検算結果と、唯一の例外を短く締める。 */
function summarySection(result) {
  const f3 = result.blockRun[3].focus;
  const s3 = result.blockRun[3].sequential;
  const marginal = (f3.letters - s3.letters) / (f3.pulls - s3.pulls);
  return `<section class="panel"><h2>まとめ</h2><p class="verdict"><b>結論：文字目的の90連が残っているか否かで、天地が分かれる。</b></p><p class="note"><b>残っている先生（ボーナス未取得のフェス限を次のフェス期に掘れる）</b>：浮いた石を${result.banking.chaseRateFes.toFixed(2)}文字/連で取り返せるため、ほぼ全構成で<b>新仕様優位</b>（+12〜+145文字。4PU早抜けのみ−16）。</p><p class="note"><b>残っていない先生（文字の受け皿なし）</b>：石を文字へ戻す手段が無く、獲得文字の差がそのまま残って<b>全構成で旧仕様優位</b>。連打で積んだ百文字級の差は返ってこない。</p><p class="note">長年の最適解「一人の生徒連打」の追加1連は補填込み${(marginal + 1.6).toFixed(2)}文字——掘りの基準${result.banking.chaseRateFes.toFixed(2)}文字/連を下回る。どちらの世界でも、連打そのものは信仰するほどの打ち方ではなかった。</p></section>`;

}

function verdictLines(result, target, withSpook) {
  const rate = result.banking.chaseRateFes;
  const line = (plan, label) => {
    const saved = plan.pulls - withSpook.expectedPulls;
    // 旧仕様側は追加で引いたぶんフェス限の欠片(16文字/10連)も拾っている。
    const lost = (plan.letters - withSpook.letters) + saved * FES_BYPRODUCT_PER_PULL;
    const recovered = saved * rate;
    const net = recovered - lost;
    return `<p class="verdict">${label}<b>呼出チャージは${stone(saved)}石安くなる代わりに${Math.round(lost)}文字減少（フェス欠片${Math.round(saved * FES_BYPRODUCT_PER_PULL)}文字分込み）。</b>浮いた${saved.toFixed(1)}連をフェス限の文字掘り（補填込み${rate.toFixed(2)}文字/連）に回すと${Math.round(recovered)}文字相当——差引${net >= 0 ? '+' : '−'}${Math.abs(Math.round(net))}文字で<b>${net >= 0 ? '呼出チャージ' : '呼出ポイント'}優位</b>。</p>`;
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





function renderFestivalHtml(result) {
  const rates = result.rates;
  const banking = result.banking;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>5.5フェス限の新旧比較</title><link rel="stylesheet" href="css/festival.css"></head><body><main><nav class="nav"><a href="./">確率表</a><a href="festival.html" aria-current="page">5.5フェス限</a><a href="faq.html">Q&amp;A</a></nav><header class="hero"><div class="header-row"><h1>5.5フェス限の新旧比較</h1>${GITHUB_LINK}</div><p class="lead">フェス限すり抜け確率が高いため、通常の募集と比べて変数が多い。5.5周年のフェス限ガチャの新旧比較検証を机上で行う。</p></header>
<section class="panel"><details><summary>計算に使う前提</summary><ul class="rules"><li>フェス限定募集の星3排出率 <b>${pct(rates.festivalStar3)}</b>。</li><li>指名1名の排出率 <b>${pct(rates.namedPu)}</b>。呼出チャージはチャージ99で50%、199で100%。</li><li>新旧フェス限10名−指名中1名の<b>9名</b>で <b>${pct(rates.spookPoolTotal)}</b> を等分、1名 <b>${pct(rates.spookEach)}</b>。</li><li>残り <b>${pct(rates.otherStar3)}</b> は恒常星3。内訳の記録のみ、計算には不使用。</li><li>初回PUボーナスは<b>指名PU自引きと呼出ポイント交換</b>のみ。すり抜けでは付かない。</li><li>素体なしを優先指名。全員素体済みなら素体持ちを指名してボーナス回収。</li><li>文字と欠片は別勘定。欠片は在庫潤沢な先生が多く、同じ重みでは扱えない。</li><li>欠片の取り分はフェス限10連80枚（平常時50枚）扱い。新旧共通のため比較に影響なし。</li><li>文字掘り（期待90連・200文字）の補填は10連価値ルールで行う。掘り先はフェス限期間にも置けるものとし+1.6文字/連（計3.82文字/連）。比較対象のフェス限側の募集にも16文字/10連を同様に計上。掘り先＝ボーナス未取得のフェス限（固有3以下の制服ネル等）が残っていることが前提。</li></ul></details></section>
${retreatSection(result)}
${summarySection(result)}
<footer>Generated by scripts/festival.js</footer></main>
<script src="js/festival.js" defer></script></body></html>`;
}

module.exports = { renderBody: renderFestivalHtml };
