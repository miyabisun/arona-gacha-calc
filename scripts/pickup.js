#!/usr/bin/env node

/**
 * 通常2PUページのビルド入口。
 * - 計算:   scripts/pickup-calc.js
 * - 本文:   scripts/render/pickup-ja.js / pickup-en.js  (各言語を直接編集。自動同期はしない)
 * - 資材:   assets/festival.css を共用(コピーは festival.js が行う)
 */

const fs = require('node:fs');
const path = require('node:path');
const calc = require('./pickup-calc.js');
const { localizeShell } = require('./localize.js');
const renderers = {
  ja: require('./render/pickup-ja.js').renderBody,
  en: require('./render/pickup-en.js').renderBody,
};

const OUTPUT_DIR = path.join(__dirname, '..', 'docs');

function renderPickup(result, locale = 'ja') {
  const renderBody = renderers[locale];
  if (!renderBody) throw new Error(`Unsupported locale: ${locale}`);
  return localizeShell(renderBody(result), locale, 'pickup');
}

function main() {
  const result = calc.calculatePickup();
  fs.mkdirSync(path.join(OUTPUT_DIR, 'en'), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'pickup.html'), renderPickup(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'en', 'pickup.html'), renderPickup(result, 'en'));
  console.log(`通常2PU: 呼出チャージ${result.charge.expectedPulls.toFixed(1)}連/200文字  呼出ポイント${result.point.expectedPulls.toFixed(1)}連/${result.point.letters.toFixed(0)}文字  検算差: ${result.audit.convolutionGap.toExponential(2)}`);
}

if (require.main === module) main();

module.exports = { ...calc, renderPickup };
