-- Migration 001: Backend account states
-- Tracks account cooldown, quota, and disabled state per backend

CREATE TABLE IF NOT EXISTS backend_account_states (
  backend TEXT NOT NULL,
  state_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (backend, state_key)
);

CREATE INDEX IF NOT EXISTS idx_backend_account_states_backend_updated
  ON backend_account_states(backend, updated_at);
