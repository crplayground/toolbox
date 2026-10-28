# CR PAGES — SETUP.md（セットアップとデプロイ）

設計は Drive の `toolbox/cr-pages/設計書.md`。この手順は `workers/cr-pages/` で実行する。

```sh
cd ~/メインデータ_GitHub/toolbox/workers/cr-pages
```

## 1. 初回だけ：Cloudflare に入れ物を作る

R2 バケット（公開ファイルの保管庫）：

```sh
npx wrangler r2 bucket create cr-pages-files
```

D1 データベース（ページ情報・集計）：

```sh
npx wrangler d1 create cr-pages-db
```

表示された `database_id`（`xxxxxxxx-xxxx-…` の形）を、`wrangler.toml` の `database_id =` の値（今は 0 だけの仮の値）に差し替える。ID は秘密ではないので、そのままコミットしてよい。

テーブルを作る（本番の D1 へ）：

```sh
npx wrangler d1 migrations apply cr-pages-db --remote
```

## 2. デプロイ

```sh
npx wrangler deploy
```

終わると `https://cr-pages.yukimiyakawa.workers.dev` で開ける。

## 3. 動作確認

`https://cr-pages.yukimiyakawa.workers.dev/api/health` を開き、次の表示になれば成功。

```
{"ok":true,"r2":true,"d1":true}
```

`r2` か `d1` が `false` なら、手順1のバケット作成・ID の差し替え・マイグレーションのどれかが済んでいない。

## ローカルで動かす

```sh
npx wrangler d1 migrations apply cr-pages-db --local
npx wrangler dev
```

`http://localhost:8787` で画面が開く。R2・D1 はローカル専用の仮のもの（本番のデータには触れない）。

## テスト

```sh
node test/unit.test.mjs
```

## 秘密情報（Phase 2 以降）

`GOOGLE_CLIENT_SECRET`・`VIEW_TOKEN_SECRET`・`PASSWORD_PEPPER`・`USER_HASH_KEY`・`ADMIN_EMAILS` は、`npx wrangler secret put <名前>` で登録する。**リポジトリ・チャット・Drive には書かない。** 登録の手順は各 Phase で案内する。
