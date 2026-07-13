CREATE TABLE tokens (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('agent','human')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE channels (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','party')),
  guard_limit INTEGER,          -- NULL=按 mode 默认；0=关闭
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
