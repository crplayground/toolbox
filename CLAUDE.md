# toolbox — CLAUDE.md（リポジトリ作業ルール）

このリポジトリ `crplayground/toolbox` は CR室ツールのモノレポ。ローカルクローンで作業する際の要点。

## 原則
- **秘密情報（APIキー・トークン・Webhook URL）はコミットしない。** Worker Secrets / GitHub Secrets で管理する。
- フロントは各ツール直下の `index.html`（GitHub Pages がルート配信）。単一HTML完結。
- Worker のソースは `workers/<tool>/`。デプロイは各フォルダで `npx wrangler deploy`。
- 公開URLは `https://crplayground.github.io/toolbox/<tool>/`。HTML内では絶対URLを避け、相対パスを使う。

## 構成
```
print-check/ revision-request/ project-board/ request/   ← フロント（Pages配信）
workers/<tool>/                                          ← Worker（別デプロイ）
```

## デプロイ
- フロント：`main` に push → GitHub Pages が自動配信。
- Worker：`cd workers/<tool> && npx wrangler deploy`（ユウキが手動）。

## 注意
- `request` の `ALLOWED_ORIGIN`（wrangler.toml）を変えたら Worker の再デプロイが必要。
- 詳細な構想・運用ルールは Google Drive `04_ツールボックス/`（CLAUDE.md / README.md）が正。
