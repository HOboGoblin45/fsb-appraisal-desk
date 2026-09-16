-- FSB Appraisal Desk, initial schema
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  pw_hash TEXT,
  pw_salt TEXT,
  pw_iter INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  last_seen TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS invites_user ON invites(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  step INTEGER NOT NULL DEFAULT 0,
  hold INTEGER NOT NULL DEFAULT 0,
  declined INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  tok_b TEXT UNIQUE,
  tok_a TEXT UNIQUE,
  appt_start TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_updated ON orders(updated_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  role TEXT NOT NULL,
  what TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_order ON events(order_id, id);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  client_visible INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL DEFAULT 'kv',
  key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_role TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS docs_order ON docs(order_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  party TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  sent_by TEXT,
  provider_id TEXT
);
CREATE INDEX IF NOT EXISTS messages_order ON messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS messages_status ON messages(status, created_at);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  screen TEXT NOT NULL DEFAULT '',
  order_ref TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ratelimit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL
);
