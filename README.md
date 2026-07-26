# arona-gacha-calc

ブルーアーカイブの1.0周年・5.5周年募集について、PUを揃えられる累積確率を計算・可視化する静的サイトです。

## 公開ページ

- [5.5周年・2人募集の厳密計算](https://miyabisun.github.io/arona-gacha-calc/)
- [1.0周年・5.5周年の1〜4人比較グラフ](https://miyabisun.github.io/arona-gacha-calc/simulation.html)
- [計算の前提とQ&A](https://miyabisun.github.io/arona-gacha-calc/faq.html)

GitHub Pagesを有効化して最初のデプロイが完了するまでは404になります。

## ディレクトリ

```text
.
├── docs/       # GitHub Pagesでそのまま公開するHTML・計算結果JSON
├── scripts/    # 計算、HTML生成、自動検算に使うNode.jsスクリプト
├── package.json
└── README.md
```

`docs/` は生成済み成果物です。`scripts/` が計算の証跡であり、乱数計算には固定シードを使うため再現できます。

## 再生成と検証

Node.js 18以降を使用します。外部パッケージは不要です。

```sh
npm run build
npm test
```

- `npm run build:exact`: 厳密DPで `docs/index.html`、`docs/faq.html`、`docs/results.json` を生成
- `npm run build:simulation`: 100万回のモンテカルロ法で1人200連〜4人800連の比較ページとJSONを生成
- `SIM_TRIALS=10000 npm run build:simulation`: 任意の試行回数で生成

## GitHub Pagesで公開する

1. このリポジトリを `main` ブランチへpushする。
2. GitHubのリポジトリ画面で **Settings → Pages** を開く。
3. **Build and deployment → Source** を **Deploy from a branch** にする。
4. Branchを **main**、Folderを **/docs** にして **Save** する。
5. Pages画面またはActions画面でデプロイ完了を確認する。初回反映には最大10分ほどかかる場合がある。

以後は `docs/` の変更を `main` へpushすると自動公開されます。公開元を削除するとPagesのビルドが失敗するため、`docs/` は残してください。

詳細は[GitHub公式のPublishing source設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)を参照してください。
