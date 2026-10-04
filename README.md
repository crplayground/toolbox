# toolbox（コード置き場）

CR室の業務効率化Webツールの**コード**をまとめたリポジトリ（GitHub `crplayground/toolbox`）。
資料・仕様・履歴は Google Drive `00_メンバー/miyakawa/toolbox/` にある。**同じ名前の2つのフォルダで、中身の役割が違う。**

| 置き場 | 入っているもの | 正（本体） |
|---|---|---|
| このリポジトリ（`メインデータ_GitHub/toolbox`） | コード・公開ページ・Worker | GitHub `crplayground/toolbox` |
| Drive `00_メンバー/miyakawa/toolbox/` | CLAUDE.md・仕様・素材・履歴（コードは置かない） | Drive |

---

## ツールの状態（2026-10-04）

| ツール | 状態 | 公開URL | Worker |
|---|---|---|---|
| **compass** | 🟢 稼働中（個人用） | https://crplayground.github.io/toolbox/compass/ | `workers/compass/` |
| **creative-process** | 🟢 稼働中（全社） | https://crplayground.github.io/toolbox/creative-process/ | `workers/creative-process/` |
| print-check | 💤 休眠（ページは公開のまま） | https://crplayground.github.io/toolbox/print-check/ | なし |
| revision-request | 💤 休眠（ページは公開のまま） | https://crplayground.github.io/toolbox/revision-request/ | `workers/revision-request/` |
| project-board | 💤 休眠（ページは公開のまま） | https://crplayground.github.io/toolbox/project-board/ | `workers/project-board/` |
| draft | 💤 休眠・未公開（コードはDriveの `_archive/draft/` のみ） | — | — |

- 休眠ツールは**消していない**。URLを知っている人が開けば今も動く。資料は Drive の `_archive/` に移した。
- ランディング `index.html`（https://crplayground.github.io/toolbox/）は休眠ツールへのリンクのまま。compass は個人用なので載せていない。

---

## フォルダ構成

```
toolbox/
├── README.md            ← このファイル（人間向けの地図）
├── CLAUDE.md            ← Claude向けの作業ルール
├── index.html           ランディング（ツール一覧）
├── compass/             🟢 公開物（ビルドで生成。手で編集しない）
├── creative-process/    🟢 公開物＋SPEC.md・design/
├── print-check/         💤 公開物
├── revision-request/    💤 公開物
├── project-board/       💤 公開物
├── apps/
│   └── compass/         compass のソース（React＋Vite）。ビルドすると compass/index.html ができる
├── workers/             Cloudflare Worker のソース（GitHubとは別に wrangler でデプロイ）
│   ├── compass/
│   ├── creative-process/
│   ├── revision-request/
│   └── project-board/
├── .github/workflows/   GitHub Pages の自動公開
└── _to_delete/          削除待ち（Gitに載らない。中身を確認したら捨ててよい）
```

---

## 公開のしくみ（止めないために知っておくこと）

| 部分 | どこで動くか | 反映のしかた |
|---|---|---|
| 画面（各 `index.html`） | GitHub Pages | `main` に push すると自動で公開 |
| Worker（保存・Notion連携・AI） | Cloudflare（`*.yukimiyakawa.workers.dev`） | 各 `workers/<tool>/` で `npx wrangler deploy`（手動） |

- **公開URLは「リポジトリ名＋フォルダ名」で決まる。** `toolbox` というリポジトリ名と、`compass/`・`creative-process/` のフォルダ名は変えないこと（変えるとURLが変わり、ツールが止まる）。
- このローカルフォルダの名前（`メインデータ_GitHub/toolbox`）も変えない。Compass の学習ルーティンがここを作業フォルダにしている。
- Worker は push では更新されない。コードを変えても `wrangler deploy` するまで本番は旧版のまま。

## セキュリティ

APIキー・トークン・Webhook URL はコードに書かない。Cloudflare Worker Secrets で管理する。手順は各 `workers/<tool>/SETUP*.md`。

## 名前の対応（旧称）

| 現在 | 旧称 |
|---|---|
| creative-process | request（2026-08-05改称） |
| compass | CR Board・project-management-board（2026-09-29改称） |
| print-check | print-checklist |
| revision-request | Drive側の旧フォルダ名は review（2026-10-04に revision-request へ統一） |
| リポジトリ `crplayground/toolbox` | 旧 `Yuki-M-15/*`（1ツール1リポジトリ。2026-07-20統合） |
