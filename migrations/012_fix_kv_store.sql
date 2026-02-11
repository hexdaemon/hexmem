-- Migration 012: Fix kv_store to support namespaced keys
-- The original schema had PRIMARY KEY on key alone, which broke multi-namespace usage.
-- This migration recreates the table with UNIQUE(namespace, key) constraint.

-- Step 1: Rename old table
ALTER TABLE kv_store RENAME TO kv_store_old;

-- Step 2: Create new table with correct constraint
CREATE TABLE kv_store (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    value_type TEXT DEFAULT 'string',  -- 'string', 'integer', 'float', 'boolean', 'json'
    namespace TEXT DEFAULT 'default',  -- for grouping related keys
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(namespace, key)
);

-- Step 3: Copy data from old table
INSERT INTO kv_store (key, value, value_type, namespace, expires_at, created_at, updated_at)
SELECT key, value, value_type, namespace, expires_at, created_at, updated_at
FROM kv_store_old;

-- Step 4: Drop old table
DROP TABLE kv_store_old;

-- Step 5: Recreate indexes
CREATE INDEX idx_kv_namespace ON kv_store(namespace);
CREATE INDEX idx_kv_expires ON kv_store(expires_at);
