-- HELLO PAGES 初期スキーマ（Phase 1）。Phase 2 以降で必要になれば 0002 以降で足す。

-- 公開ページ。status: pending（送信中）／active／expired／deleted
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,          -- UUID v4。URL に使う
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  password_hash TEXT,                      -- 鍵付きハッシュのみ。平文は保存しない
  owner_hash    TEXT NOT NULL,             -- 公開者の匿名ハッシュ（上限判定・集計用）
  owner_email   TEXT,                      -- 追跡用。どの画面・APIにも出さない。purge_at 経過後に消す
  files_json    TEXT NOT NULL,             -- [{path,size}]
  file_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,          -- epoch 秒
  expires_at    INTEGER NOT NULL,
  purge_at      INTEGER NOT NULL,          -- owner_email を消す時刻（expires_at + 90日）
  failed_count  INTEGER NOT NULL DEFAULT 0,-- パスワード連続失敗回数
  locked_until  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pages_owner ON pages (owner_hash, status);
CREATE INDEX pages_expires ON pages (status, expires_at);

-- 公開のたびに1行。期限後も残す（月別・年別の集計用）。個人は匿名ハッシュのみ。
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  month       TEXT NOT NULL,               -- 'YYYY-MM'（JST）
  year        TEXT NOT NULL,               -- 'YYYY'（JST）
  user_hash   TEXT NOT NULL,
  file_count  INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  html_bytes  INTEGER NOT NULL,
  css_bytes   INTEGER NOT NULL,
  js_bytes    INTEGER NOT NULL,
  other_bytes INTEGER NOT NULL
);
CREATE INDEX events_month ON events (month);
CREATE INDEX events_year ON events (year);

-- ビュー数（パスワード解除の回数）の日別カウンタ。
CREATE TABLE views (
  day   TEXT PRIMARY KEY,                  -- 'YYYY-MM-DD'（JST）
  count INTEGER NOT NULL DEFAULT 0
);
