-- Migration 007: Usage event error counters
-- Adds 429/503 error count columns for Google account error tracking

ALTER TABLE usage_events
  ADD COLUMN error_429_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_events
  ADD COLUMN error_503_count INTEGER NOT NULL DEFAULT 0;
