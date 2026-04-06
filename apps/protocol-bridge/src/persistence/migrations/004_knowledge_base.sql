-- Migration 004: Knowledge base
-- Stores user and auto-generated knowledge items

CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  knowledge TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_generated INTEGER NOT NULL DEFAULT 0
);
