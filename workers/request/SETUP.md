# creative-request Worker セットアップ手順

> 既存ツール（revision-share / project-board）と同じ Cloudflare Worker 構成です。
> ターミナルで `creative-request` フォルダに移動してから順に実行します。
> 専門用語は都度補足します。詰まったら画面のスクショを送ってください。

```
cd "（このフォルダのパス）/creative-request"
```

---

## 0. 前提（最初の1回だけ）

- Cloudflare アカウントにログイン：`npx wrangler login`
  → ブラウザが開くので承認するだけ。
- 「Secrets（シークレット）」＝鍵を安全にサーバーへ預ける仕組み。鍵はこのフォルダのファイルには**書きません**。

---

## 1. 共有HTMLの倉庫(KV)を作る

KV＝送信された依頼を「共有ページ」として保存しておく小さな倉庫です。

```
npx wrangler kv namespace create REQUESTS
```

出てきた `id = "..."` をコピーします。

## 2. IDを wrangler.toml に貼る

`wrangler.toml` の
`id = "ここに creative-request 用 KV の ID を貼り付け"`
を、手順1のIDに置き換えて保存します。

## 3. 鍵（Secrets）を登録する

1つずつ実行し、聞かれたら値を貼り付けます（値は画面に残りません）。

```
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DB_ID
```

- `NOTION_TOKEN`：Notionインテグレーションのトークン。
  Notion → 設定 → コネクト → インテグレーション作成 → 対象DB「案件管理（テスト）」にだけ共有 → トークンをコピー。
- `NOTION_DB_ID`：登録先DBの ID。DBを開いた時のURL `notion.so/xxxx?v=...` の `xxxx` 部分（32文字）。

Slackは Webhook が hiro さんから届いてから登録します（届くまではSlack投稿は自動でスキップされ、他は動きます）。

```
npx wrangler secret put SLACK_WEBHOOK_URL   # ← Webhookが届いてから
```

## 4. 公開する（デプロイ）

```
npx wrangler deploy
```

成功すると `https://creative-request.<あなたのサブドメイン>.workers.dev` が発行されます。
このURLが依頼の受け口になります（フォーム側の送信先にこのURLを設定します）。

---

## 5. 動作確認

- ブラウザで `https://creative-request.<...>.workers.dev/` を開く
  → 「creative-request Worker は稼働中です。」が出れば起動OK。
- フォーム送信のテストは、フォームMVP（次の工程）を作ってから通します。
  Worker単体のテストをしたい場合は、curl で `/submit` にJSONを送る方法を別途案内します。

---

## 6. 仕上げ（本番前）

- `wrangler.toml` の `[vars] ALLOWED_ORIGIN` に、フォームを置く GitHub Pages のURL
  （例 `https://yuki-m-15.github.io`）を設定して再デプロイ。
  → これで「想定したフォーム以外からの書き込み」を弾けます。
- Notionに「共有URL」専用のプロパティ（URL型）を作ったら、
  `[vars] SHARE_URL_PROP` にその名前を設定して再デプロイ。
  → 設定しない場合も、共有URLはNotionページ本文の先頭に必ず記録されます。

---

## 環境変数まとめ

| 名前 | 種別 | 必須 | 用途 |
|---|---|---|---|
| NOTION_TOKEN | Secret | ○ | Notion登録の認証 |
| NOTION_DB_ID | Secret | ○ | 登録先DB |
| SLACK_WEBHOOK_URL | Secret | △ | 受付chへの投稿（未設定ならスキップ） |
| ALLOWED_ORIGIN | Var | △ | 送信元フォームの制限（本番前に設定） |
| SHARE_URL_PROP | Var | × | 共有URLを入れるNotion URL型プロパティ名 |
| NOTION_VERSION | Var | × | Notion APIバージョン（既定 2022-06-28） |
