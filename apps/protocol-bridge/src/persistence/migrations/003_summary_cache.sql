-- Migration 003: Summary cache
-- Caches conversation summaries keyed by content hash

CREATE TABLE IF NOT EXISTS summaries (
  hash TEXT PRIMARY KEY,
  summary_text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_last_used
  ON summaries(last_used_at);
