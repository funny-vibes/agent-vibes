CREATE TABLE IF NOT EXISTS realtime_calls (
  call_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  history_policy TEXT NOT NULL,
  account_key TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'signaled',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
