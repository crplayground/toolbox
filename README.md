# toolbox

株式会社CRAZY クリエイティブ室（CR室）の業務効率化Webツールを集約したモノレポ。
旧「1ツール=1リポジトリ」（`Yuki-M-15/*`）から、この単一リポジトリ `crplayground/toolbox` に統合。

## 公開URL（GitHub Pages・ルート配信）

| ツール | パス | 公開URL |
|---|---|---|
| ランディング | `/` | https://crplayground.github.io/toolbox/ |
| 入稿前チェック | `/print-check/` | https://crplayground.github.io/toolbox/print-check/ |
| 修正依頼 | `/revision-request/` | https://crplayground.github.io/toolbox/revision-request/ |
| タスクボード | `/project-board/` | https://crplayground.github.io/toolbox/project-board/ |
| 制作依頼フォーム | `/request/` | https://crplayground.github.io/toolbox/request/ |

## 構成

```
toolbox/
├── index.html            ランディング（ツール一覧）
├── .nojekyll             Jekyll処理を無効化（素の静的配信）
├── print-check/          入稿前チェック（静的のみ・Workerなし）
├── revision-request/     修正依頼（Worker: revision-share）
├── project-board/        タスクボード（Worker: notion-proxy）
├── request/              制作依頼フォーム（Worker: creative-request）
└── workers/              Cloudflare Worker のソース（Pages配信対象外・wranglerで別デプロイ）
    ├── revision-request/
    ├── project-board/
    └── request/
```

フロント（各 `index.html`）は GitHub Pages が配信。バックエンドの Worker は Cloudflare 上で
`*.yukimiyakawa.workers.dev` として独立稼働しており、リポジトリ移設の影響を受けない。

## 移設後に必要な対応（重要）

1. **request の Worker を再デプロイ**：`workers/request/wrangler.toml` の `ALLOWED_ORIGIN` を
   新オリジン `https://crplayground.github.io` を含む値に更新済み。`cd workers/request && npx wrangler deploy` で反映する。
   （更新しないと新URLからの依頼フォーム送信がCORSで拒否される）
2. **GitHub Pages を有効化**：Settings → Pages → Source: `main` / root。
3. **Actions（日次通知）はまだ有効化していない**：`workers/project-board/daily-task-notify.yml` は参照用。
   稼働させるには `.github/workflows/` に移し、Secrets を新リポジトリに再登録し、`notify.py` のパスを合わせる必要がある（別作業）。

## セキュリティ

APIキー・トークン・Webhook URL はコードに書かない。Cloudflare Worker Secrets / GitHub Secrets で管理する。
各 Worker のセットアップは `workers/<tool>/SETUP*.md` を参照。

## 命名

旧リポジトリ名との対応：print-checklist → print-check、revision-request（維持）、project-board（維持）、request（維持）。
