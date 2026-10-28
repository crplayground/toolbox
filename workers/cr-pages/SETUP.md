# HELLO PAGES — SETUP.md（セットアップとデプロイ）

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

## 期限切れの自動削除（定期実行）

`wrangler.toml` の `[triggers]` で、毎時0分に自動実行される（デプロイすると有効になる。Cloudflare の画面での設定は不要）。

- 期限が切れたページのファイルを R2 から削除する（1回に10件まで。残りは次の時間に回る）。
- 公開の途中で止まった残骸（1時間以上たった未完了のもの）も削除する。
- 期限から90日たった記録（公開者のメールを含む）を削除する。集計用の記録は残る。

閲覧は、定期実行を待たず、期限と同時に止まる。動いているかは、次のコマンドでログを見る（`[cr-pages] cleanup {...}` の行）。

```sh
npx wrangler tail
```

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

## Googleログインの準備（Phase 2）

HELLO PAGES 専用の OAuth クライアントを作る（無料。Creative Process のクライアントには触れない）。

1. https://console.cloud.google.com を開き、プロジェクト `creative-request-503219` を選ぶ。
2. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」。
3. アプリケーションの種類＝「ウェブ アプリケーション」、名前＝`cr-pages`。
4. 「承認済みの JavaScript 生成元」に次の2つを追加する。
   - `https://cr-pages.yukimiyakawa.workers.dev`
   - `http://localhost:8787`（ローカルでの確認用）
5. 「作成」を押す。表示される**クライアント ID**を `wrangler.toml` の `GOOGLE_CLIENT_ID = ""` に貼る（公開してよい値）。
6. 表示される**クライアント シークレット**は、次の「秘密情報の登録」で使う。**チャット・ファイル・Drive には貼らない。** 作成直後にしか見られないことがあるので、すぐにコピーする。ダウンロードできる JSON は保存しない。
7. 「Google Auth Platform」（旧称：OAuth 同意画面）の対象が「内部」になっているか確認する。

## 秘密情報の登録（Phase 2）

次の4つを登録する。**リポジトリ・チャット・Drive には書かない。**

ランダムな鍵は、コマンドの出力を直接渡すので、画面にも履歴にも値が残らない。

```sh
openssl rand -base64 48 | npx wrangler secret put VIEW_TOKEN_SECRET
openssl rand -base64 48 | npx wrangler secret put PASSWORD_PEPPER
openssl rand -base64 48 | npx wrangler secret put USER_HASH_KEY
```

シークレットは、実行して聞かれたところで貼る（貼った文字は画面に出ない）。

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**`PASSWORD_PEPPER` と `USER_HASH_KEY` は、登録後に変更しない。** `PASSWORD_PEPPER` を変えると公開中のページのパスワードが全部通らなくなり、`USER_HASH_KEY` を変えると年別の利用ユーザー数が重複して数えられる。`VIEW_TOKEN_SECRET` を変えると、閲覧中の人がもう一度パスワードを入れることになるだけ。

登録できたか確認：

```sh
npx wrangler secret list
```

4つの名前が表示されればよい。

## ローカルで公開まで試す場合

`workers/cr-pages/.dev.vars`（Git に入らない）に、ローカル用の仮の値を書く。本番の値は書かない。

```
GOOGLE_CLIENT_ID=（作成したクライアントID）
GOOGLE_CLIENT_SECRET=（ローカルで試すときだけ）
VIEW_TOKEN_SECRET=local-view-secret
PASSWORD_PEPPER=local-pepper
USER_HASH_KEY=local-user-key
```

## 公開機能を一通りテストする

```sh
node test/flow.test.mjs
```

Google・D1・R2 をメモリ上の代用品に置き換えて、ログイン検証 → 公開 → ロック画面 → 閲覧 → 上限・期限を通して確認する。
