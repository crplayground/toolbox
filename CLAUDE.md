# toolbox — CLAUDE.md（リポジトリ作業ルール）

このリポジトリ `crplayground/toolbox` は CR室ツールのモノレポ。ローカルクローンで作業する際の要点。
人間向けの地図は `README.md`。

## 原則
- **秘密情報（APIキー・トークン・Webhook URL）はコミットしない。** Worker Secrets / GitHub Secrets で管理する。
- フロントは各ツール直下の `index.html`（GitHub Pages がルート配信）。単一HTML完結。
- ビルドが必要なツール（Figma起点・React＋Vite）は、ソースを `apps/<tool>/` に置き、`npm run build` で `<tool>/index.html` を生成してコミットする。`node_modules/` はコミットしない。
- Worker のソースは `workers/<tool>/`。デプロイは各フォルダで `npx wrangler deploy`。
- 公開URLは `https://crplayground.github.io/toolbox/<tool>/`。HTML内では絶対URLを避け、相対パスを使う。
- **稼働中は compass と creative-process の2つ。** この2つの `index.html`・Worker・フォルダ名・リポジトリ名は、ユウキの明示的な指示なしに変更・移動しない。
- 休眠ツール（print-check・revision-request・project-board）は公開ページを残している。削除・移動は社内影響の確認後にユウキが判断する。

## 構成
```
compass/ creative-process/                    ← 稼働中のフロント（Pages配信）
print-check/ revision-request/ project-board/ ← 休眠中のフロント（Pages配信・公開のまま）
apps/<tool>/                                  ← ビルドが必要なツールのソース
workers/<tool>/                               ← Worker（別デプロイ）
_to_delete/                                   ← 削除待ち（gitignore済み）
```

## デプロイ
- フロント：`main` に push → GitHub Pages が自動配信。
- Worker：`cd workers/<tool> && npx wrangler deploy`（ユウキが手動）。

## 注意
- `creative-process` の `ALLOWED_ORIGIN`（wrangler.toml）を変えたら Worker の再デプロイが必要。
- ローカルフォルダ名 `メインデータ_GitHub/toolbox` は変えない（Compass学習ルーティンの作業フォルダ）。
- 詳細な運用ルールの置き場所：Google Drive `00_メンバー/miyakawa/toolbox/`（2026-10-04に `tool/` から改名）。
  - **creative-process** は `toolbox/creative-process/CLAUDE.md` が正
  - **compass** は `toolbox/compass/CLAUDE.md` が正
  - その他・共通ルールは `toolbox/CLAUDE.md` が正
- ヒアリーのシステム指示の正本はDrive側。`workers/creative-process/tools/build-prompt.mjs` は `toolbox/` → 旧 `tool/` の順で探す。
