# arona-gacha-calc

ブルーアーカイブの「呼出ポイント」と「呼出チャージ」について、必要なPU数を揃えるまでの累積確率を1連単位で計算・可視化する静的サイトです。日本語と英語のページをGitHub Pagesで公開します。

An exact, bilingual probability calculator comparing Recruitment Points and Recruitment Charge in Blue Archive.

## 公開ページ

| 言語 | 確率表 | 計算方法とQ&A |
| --- | --- | --- |
| 日本語 | [確率表](https://miyabisun.github.io/arona-gacha-calc/) | [計算方法とQ&A](https://miyabisun.github.io/arona-gacha-calc/faq.html) |
| English | [Probability chart (EN)](https://miyabisun.github.io/arona-gacha-calc/en/) | [Q&A (EN)](https://miyabisun.github.io/arona-gacha-calc/en/faq.html) |

## 計算モデル

- 通常の対象PU排出率は1連あたり0.7%。現在狙っているPU本人の獲得だけを数え、対象外PUのすり抜けは数えない。
- 「kPUをn連で」は、k人を順番に狙い、n連以内に全員を揃えられる累積確率を表す。
- 呼出チャージは、チャージ99から100になる募集でPU率50%、199から200になる募集で100%。PU獲得時にチャージを0へ戻す。
- 呼出ポイントは1連につき1ptを加算し、n連時点で `floor(n / 200)` 人まで未獲得PUと交換できる。
- 呼出チャージは状態DPと単一PU所要回数分布の畳み込み、呼出ポイントは状態DPと二項分布の閉形式をそれぞれ照合する。
- モンテカルロ法や丸めた百分率は計算に使用しない。

計算結果には、1〜10PUをそれぞれ最大200連/PUで揃える累積確率と、1〜4PUの期待募集回数・期待青輝石消費量が含まれます。

## リポジトリ構成

```text
.
├── docs/
│   ├── en/             # English HTML
│   ├── img/            # 1〜4PUの共有SVG
│   ├── index.html      # 日本語の確率表
│   ├── faq.html        # 日本語のQ&A
│   └── *.json          # 計算結果と監査データ
├── scripts/
│   ├── compare.js      # 1〜10PUの厳密計算、グラフ、HTML/SVG生成
│   ├── calculate.js    # 2PUの詳細検算、期待値、Q&A生成
│   ├── localize.js     # 日英ナビゲーションと翻訳補助
│   └── *.test.js       # 境界値、不変条件、独立計算との照合
├── DESIGN.md           # Kinari/Sumiデザイントークン
├── LICENSE
└── package.json
```

`scripts/` を計算とページ生成の一次情報、`docs/` を再生成可能な配布成果物として管理します。日英ページは同じ計算結果から生成され、SVGとJSONは `docs/` 直下の共有資産です。

## 必要環境と検証

- Node.js 18以上
- 外部npmパッケージなし

```sh
npm run build
npm test
```

`npm run build` はHTML、JSON、SVGを `docs/` 以下へ再生成します。`npm test` は確率質量の保存、累積確率の単調性、天井到達時の100%、および独立した計算法との誤差が `1e-12` 以下であることを検証します。

## 配布

GitHub Pagesの公開元は `main` ブランチの `/docs` です。`docs/` の生成物を含む変更が `main` に反映されると、日本語版と英語版が同じデプロイから配布されます。

## ライセンス

[MIT License](LICENSE)
