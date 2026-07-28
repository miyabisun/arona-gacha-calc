---
type: Decision
title: ビルド構成と編集手順
description: arona-gacha-calcのビルドパイプライン、フェス限ページの分割構成、編集時の検証手順に関する現行判断。
status: stable
tags: [architecture, build, i18n, token-cost]
sources:
  - id: repo
    resource: file:///home/miyabi/works/gacha-calc
    title: arona-gacha-calc repository
    last_modified: 2026-07-28
---

# 現行の判断

## 全体構成

- 静的サイト。`npm run build` が `scripts/{calculate,compare,festival}.js` を実行し `docs/` に出力、main ブランチの `/docs` を GitHub Pages が配信する。
- `docs/` 配下は全て生成物。直接編集しない(手編集はビルドで消える)。
- `npm test` はフェス限25本を含む node:test。リリース前に必ず通す。

## フェス限ページの分割(2026-07-28、トークンコスト削減リファクタ)

ユーザーの依頼「毎回巨大HTMLを丸ごと編集するコストを下げる」に対する採用案:

- `scripts/festival-calc.js` — 厳密DPと台帳。数値ロジックはここだけ。
- `scripts/render/festival-ja.js` / `festival-en.js` — 各言語の本文レンダラ。
  **言語ごとに直接編集し、自動同期はしない**。旧 ENGLISH_REPLACEMENTS
  (140ペアの置換テーブル)は廃止した。ペア管理の whack-a-mole が
  編集コストの主因だったため(agent推論、ユーザー承認済みの方向性)。
- `scripts/festival.js` — 薄いオーケストレータ。`renderBody → localizeShell` して書き出す。
- `assets/festival.css`, `assets/festival-tabs.js`, `assets/github-html.html 相当` —
  変動しないおまじないは assets へ分離し、ビルドが docs/ へコピーする。
- `bin/festival-numbers.js` — 正準数値の一括ダンプ。前提知識の再導出を禁止する装置。

不採用: Markdown からの HTML 生成。動的数値が約50箇所ありプレースホルダ管理自体が
トークンを食うため(ユーザーは「案の取捨選択」を明示的に許可)。

## 編集時の手順

1. 文言変更 → `scripts/render/festival-ja.js` と `festival-en.js` を各々編集
2. 数値・ロジック変更 → `scripts/festival-calc.js` を編集
3. `node scripts/festival.js && npm test` で検証、`git status docs/` で差分確認
4. コミットは英語 Conventional Commits。push はユーザーの明示許可時のみ

## i18n の共通部

`scripts/localize.js` の `localizeShell` はナビ・hreflang・言語切替の共通シェルで、
calculate.js / compare.js は今も `replaceExact` ペア方式を使っている。
localize.js を触るときは3ページ全部に影響することに注意。
