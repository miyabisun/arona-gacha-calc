#!/usr/bin/env node

/**
 * 5.5周年フェス限ページのビルド入口。
 * - 計算:   scripts/festival-calc.js  (厳密DPと台帳。数値の一覧は bin/festival-numbers.js)
 * - 本文:   scripts/render/festival-ja.js / festival-en.js  (各言語を直接編集。自動同期はしない)
 * - 資材:   assets/festival.css, assets/festival-tabs.js, assets/github-link.html
 */

const fs = require('node:fs');
const path = require('node:path');
const calc = require('./festival-calc.js');
const { localizeShell } = require('./localize.js');
const renderers = {
  ja: require('./render/festival-ja.js').renderBody,
  en: require('./render/festival-en.js').renderBody,
};

const OUTPUT_DIR = path.join(__dirname, '..', 'docs');
const ASSETS = path.join(__dirname, '..', 'assets');

function renderFestival(result, locale = 'ja') {
  const renderBody = renderers[locale];
  if (!renderBody) throw new Error(`Unsupported locale: ${locale}`);
  return localizeShell(renderBody(result), locale, 'festival');
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
  const result = calc.calculateFestival();
  fs.mkdirSync(path.join(OUTPUT_DIR, 'en'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, 'css'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, 'js'), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'festival-results.json'), `${JSON.stringify(thinForJson(result), null, 2)}\n`);
  fs.copyFileSync(path.join(ASSETS, 'festival.css'), path.join(OUTPUT_DIR, 'css', 'festival.css'));
  fs.copyFileSync(path.join(ASSETS, 'festival-tabs.js'), path.join(OUTPUT_DIR, 'js', 'festival.js'));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'festival.html'), renderFestival(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'en', 'festival.html'), renderFestival(result, 'en'));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`厳密計算: ${elapsedMs.toFixed(0)}ms  質量誤差: ${result.audit.maxMassError.toExponential(2)}`);
}

if (require.main === module) main();

module.exports = { ...calc, renderFestival };
