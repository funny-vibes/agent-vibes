-- Migration 002: Chat sessions
-- Persists session state for restart recovery

CREATE TABLE IF NOT EXISTS cursor_sessions (
  conversation_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cursor_sessions_last_activity
  ON cursor_sessions(last_activity_at);
