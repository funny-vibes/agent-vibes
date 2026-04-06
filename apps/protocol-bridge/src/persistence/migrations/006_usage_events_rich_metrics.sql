-- Migration 006: Usage event rich metrics
-- Adds cache-write, web-search, and duration fields for richer analytics

ALTER TABLE usage_events
  ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_events
  ADD COLUMN web_search_requests INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_events
  ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
