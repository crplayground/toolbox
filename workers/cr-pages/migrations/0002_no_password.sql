-- パスワードなしで公開するページの印。1 = パスワードなし（URLを知っていれば誰でも開ける）。
-- password_hash が空なだけでは「誰も開けない」状態と区別がつかないため、明示の列で持つ。
ALTER TABLE pages ADD COLUMN no_password INTEGER NOT NULL DEFAULT 0;
