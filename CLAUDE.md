# toolbox — CLAUDE.md

このリポジトリ `crplayground/toolbox` は CR室ツールのモノレポ。**公開リポジトリで、GitHub Pages がリポジトリ全体を配信している＝ここに置いたものはすべて世界に公開される。**

作業ルールの本体は `CLAUDE.local.md`（Drive 上の非公開の CLAUDE.md へのシンボリックリンク。gitignore 済み）で、Claude Code が起動時に自動で読む。
**`CLAUDE.local.md` が読み込まれていない・開けないときは、作業を始めずにユウキに知らせる。**

本体が読めない場合でも、次の3つは必ず守る。

1. **公開してよいものだけを置く。** 個人情報（氏名・メールアドレス・名簿・個人の作業記録など）・秘密情報（APIキー・トークン・Webhook URL）は一切コミットしない。公開してよいか迷ったら、置く前にユウキに確認する。
2. **Claude は git コマンドを実行しない。** commit・push はユウキが GitHub Desktop で行う。変更した作業の終わりに Push サマリーを出す。
3. **稼働中の `compass/`・`creative-process/` のフォルダ名とリポジトリ名を変えない**（公開URLが変わり、ツールが止まる）。

人間向けの地図は `README.md`。
