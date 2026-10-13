CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  image_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  thumb_size INTEGER NOT NULL DEFAULT 256,
  page_url TEXT,
  title TEXT,
  note TEXT,
  meta_json TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_shots_app_status_created
  ON shots (app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shots_status_created
  ON shots (status, created_at DESC);

CREATE TABLE IF NOT EXISTS used_tickets (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_tickets_expires
  ON used_tickets (expires_at);
