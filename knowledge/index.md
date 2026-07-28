---
okf_version: "0.2"
---

# arona-gacha-calc

ブルアカのガチャ確率を厳密DPで計算し GitHub Pages に公開する静的サイト
(公開先 https://miyabisun.github.io/arona-gacha-calc/)。
この `knowledge/` はリポジトリ内で完結する長期ナレッジで、セッションを跨いで必要になる
ドメイン仕様・会計ルール・編集手順を保持する。作業開始時はまずここを読む。

## まず読む

- [ビルド構成と編集手順](decisions/site-architecture.md) - どのファイルを編集し、何を実行して検証するか
- [フェス限ページの会計ルール](decisions/festival-accounting.md) - 補填・戦略・結論の確定ルール(ユーザー裁定)
- [ガチャ仕様(5.5周年フェス)](references/gacha-spec.md) - 確率内訳・文字経済・チャージ引き継ぎの事実

## 数値が必要なとき

記事の正準数値は `node bin/festival-numbers.js` で一括出力する。
アドホックな `node -e` 再計算スクリプトを書かないこと。
