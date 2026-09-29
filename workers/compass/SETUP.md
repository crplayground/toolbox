# Project Management Board: Compass — Worker セットアップ手順

ターミナルで上から順に実行します。1コマンドずつコピーしてください。

```
cd ~/メインデータ_GitHub/toolbox/workers/compass
```

## 0. Cloudflareにログイン（済んでいれば不要）

```
npx wrangler login
```

## 1. データの倉庫（KV）を作る

```
npx wrangler kv namespace create DATA
```

出てきた `id = "..."` の値をコピーし、`wrangler.toml` の `ここに手順1で出たIDを貼り付け` と置き換えて保存します。

## 2. 合言葉を登録する

合言葉＝アプリからデータを読み書きするための鍵。20文字以上のランダムな文字列にしてください（パスワード管理ツールで生成するのがおすすめ）。聞かれたら値を貼り付けます（画面には残りません）。

```
npx wrangler secret put APP_TOKEN
```

## 3. 依頼ページ読み取り用のNotionトークンを登録する（任意）

読み取り専用のインテグレーション「Compass（読み取り）」を作り（機能は「コンテンツを読み取る」のみ）、依頼DB（📁 クリエイティブプロジェクト）の「…」→「接続」で追加してから、そのトークンを登録します。依頼フォームのトークン（書き込み権限あり）は流用しません。登録しなければ「Notionページから」の読み込みだけが使えません。

```
npx wrangler secret put NOTION_TOKEN
```

## 3-2. WBS提案用のGeminiキーを登録する（任意）

AI Studio で、プロジェクト `creative-request`（有料枠）に Compass 専用のキーを作って登録します。依頼フォームのキーは流用しません。未登録なら「読んで提案を作る」だけが使えず、「AIを使わずに読み込む」は使えます。

```
npx wrangler secret put GEMINI_API_KEY
```

## 3-3. 学習レポート用の読み取りトークンを登録する（任意）

Claudeデスクトップの定期タスク（平日19時の学習レポート）が使う、`GET /learning` 専用のトークンです。手順は G-Drive `tool/compass/学習ループ_定期タスク.md` を参照。

```
cat ~/.config/compass/learn_token | npx wrangler secret put LEARN_TOKEN
```

## 4. 公開する

```
npx wrangler deploy
```

最後に表示される `https://compass.<サブドメイン>.workers.dev` がWorkerのURLです。アプリの `src/lib/api.ts` の `WORKER_URL` と一致しているか確認してください。

## 5. アプリ側

アプリ右上の歯車（接続設定）を開き、手順2の合言葉を入力して保存します。

## 補足

- バックアップ：その日の最初の保存時に、直前の状態を `backup:YYYY-MM-DD` として30日間保存します
- 無料プランのKV書き込み上限は1日1,000回。アプリは変更後1.5秒まとめてから保存するため、通常の使い方では届きません
