-- v2.1: real delivery. Provider delivery state on messages, system mail (invites, resets, feedback,
-- tests) that belongs to no order, password-reset links, SMS opt-outs, and inbound replies.
ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN delivery_at TEXT;
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'notice';
CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider_id);
ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite';
CREATE TABLE IF NOT EXISTS optouts (
  addr TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS inbound (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  channel TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  order_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  provider_id TEXT,
  handled TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS inbound_at ON inbound(at);
