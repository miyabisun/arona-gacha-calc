# arona-gacha-calc

ブルーアーカイブの呼出ポイント・呼出チャージについて、PUを揃えられる1連ごとの厳密な累積確率を計算・可視化する静的サイトです。

## 公開ページ

- [呼出ポイント・呼出チャージの1〜10PU比較グラフ](https://miyabisun.github.io/arona-gacha-calc/)
- [計算の前提とQ&A](https://miyabisun.github.io/arona-gacha-calc/faq.html)

GitHub Pagesを有効化して最初のデプロイが完了するまでは404になります。

## ディレクトリ

```text
.
├── docs/       # GitHub Pagesで公開するHTML・計算結果JSON・1〜4PUのSVG
├── scripts/    # 計算、HTML生成、自動検算に使うNode.jsスクリプト
├── LICENSE
├── package.json
└── README.md
```

`docs/` は生成済み成果物です。`scripts/` が計算の証跡です。状態DPを独立した畳み込み・二項分布計算と照合しており、乱数は使用しません。

## 再生成と検証

Node.js 18以降を使用します。外部パッケージは不要です。

```sh
npm run build
npm test
```

- `npm run build:comparison`: 厳密DPで比較ページ、JSON、`docs/img/1pu.svg`〜`4pu.svg`を生成
- `npm run build:faq`: Q&Aと詳細な2人募集の検算JSONを生成

## GitHub Pagesで公開する

1. このリポジトリを `main` ブランチへpushする。
2. GitHubのリポジトリ画面で **Settings → Pages** を開く。
3. **Build and deployment → Source** を **Deploy from a branch** にする。
4. Branchを **main**、Folderを **/docs** にして **Save** する。
5. Pages画面またはActions画面でデプロイ完了を確認する。初回反映には最大10分ほどかかる場合がある。

以後は `docs/` の変更を `main` へpushすると自動公開されます。公開元を削除するとPagesのビルドが失敗するため、`docs/` は残してください。

詳細は[GitHub公式のPublishing source設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)を参照してください。

## ライセンス

[MIT License](LICENSE)
