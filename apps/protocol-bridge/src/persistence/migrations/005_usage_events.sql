-- Migration 005: Usage events
-- Persists per-request token usage for analytics and historical summaries

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL,
  transport TEXT NOT NULL,
  model_name TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_label TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_recorded_at
  ON usage_events(recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_backend_recorded
  ON usage_events(backend, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_model_recorded
  ON usage_events(model_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_account_recorded
  ON usage_events(account_key, recorded_at DESC);
