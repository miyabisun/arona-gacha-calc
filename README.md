# arona-gacha-calc

ブルーアーカイブの「呼出ポイント」と「呼出チャージ」について、必要なPU数を揃えるまでの累積確率を1連単位で計算・可視化する静的サイトです。日本語と英語のページをGitHub Pagesで公開します。

An exact, bilingual probability calculator comparing Recruitment Points and Recruitment Charge in Blue Archive.

## 公開ページ

| 言語 | 確率表 | 5.5周年フェス限 | 計算方法とQ&A |
| --- | --- | --- | --- |
| 日本語 | [確率表](https://miyabisun.github.io/arona-gacha-calc/) | [5.5th](https://miyabisun.github.io/arona-gacha-calc/festival.html) | [計算方法とQ&A](https://miyabisun.github.io/arona-gacha-calc/faq.html) |
| English | [Probability chart (EN)](https://miyabisun.github.io/arona-gacha-calc/en/) | [5.5th (EN)](https://miyabisun.github.io/arona-gacha-calc/en/festival.html) | [Q&A (EN)](https://miyabisun.github.io/arona-gacha-calc/en/faq.html) |

## 計算モデル

- 通常の対象PU排出率は1連あたり0.7%。現在狙っているPU本人の獲得だけを数え、対象外PUのすり抜けは数えない。
- 「kPUをn連で」は、k人を順番に狙い、n連以内に全員を揃えられる累積確率を表す。
- 呼出チャージは、チャージ99から100になる募集でPU率50%、199から200になる募集で100%。PU獲得時にチャージを0へ戻す。
- 呼出ポイントは1連につき1ptを加算し、n連時点で `floor(n / 200)` 人まで未獲得PUと交換できる。
- 呼出チャージは状態DPと単一PU所要回数分布の畳み込み、呼出ポイントは状態DPと二項分布の閉形式をそれぞれ照合する。
- モンテカルロ法や丸めた百分率は計算に使用しない。

計算結果には、1〜10PUをそれぞれ最大200連/PUで揃える累積確率と、1〜4PUの期待募集回数・期待青輝石消費量が含まれます。

### 5.5周年フェス限モデル

フェス限定募集は星3排出率が6%へ倍化し、指名していないフェス限生徒も出現します。このため上記の基本モデルとは別に、すり抜けを含めた専用の計算を行います。

- 星3の6%は、指名PU 0.7%、指名中の1名を除いた新旧フェス限9名で等分する0.9%（1名あたり0.1%）、恒常星3の4.4%に分かれる。4.4%は内訳として記録するだけで計算には使わない。
- 状態は「初回PUボーナス取得数 × すり抜けのみで確保した数 × 呼出チャージ」。生徒を同質として扱い、人数だけを持つ。
- 初回PUボーナスは指名PUの自引きと呼出ポイント交換でのみ得られる。すり抜けでの確保は素体だけを増やす。
- チャージ99の確定50%を外した残り50%でのみ通常抽選が回り、チャージ199は確定のためすり抜けが起きない。
- すり抜けはボーナス側の分布に影響しないため、ボーナスの曲線は基本モデルの結果と厳密に一致する。この一致をテストで検証している。

## リポジトリ構成

```text
.
├── docs/
│   ├── en/             # English HTML
│   ├── img/            # 1〜4PUの共有SVG
│   ├── index.html      # 日本語の確率表
│   ├── festival.html   # 日本語の5.5周年フェス限比較
│   ├── faq.html        # 日本語のQ&A
│   └── *.json          # 計算結果と監査データ
├── scripts/
│   ├── compare.js      # 1〜10PUの厳密計算、グラフ、HTML/SVG生成
│   ├── calculate.js    # 2PUの詳細検算、期待値、Q&A生成
│   ├── festival.js     # フェス限のすり抜けを含む厳密計算とページ生成
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
