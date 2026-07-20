# 本番Worker セットアップ手順

テスト用(revision-share-test)はそのまま残し、本番用(revision-share)を別に立てます。
ターミナルで `url-share-prod` フォルダに移動してから実行してください。

```
cd "（このフォルダのパス）/url-share-prod"
```

## 1. 本番用の倉庫(KV)を作る

```
npx wrangler kv namespace create REVISIONS
```

出てきた `id = "..."` をコピー。

## 2. IDを wrangler.toml に貼る

`wrangler.toml` の `id = "ここに本番用KVのIDを貼り付け"` を、手順1のIDに置き換えて保存。

## 3. 公開する

```
npx wrangler deploy
```

成功すると `https://revision-share.yukimiyakawa.workers.dev` が発行されます。
このURLが本番の修正指示シェアになります（index.html はこのURLを指すように設定済み）。
