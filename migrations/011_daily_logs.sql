-- 011_daily_logs.sql
-- Replace memory/YYYY-MM-DD.md with structured daily logs inside HexMem.

CREATE TABLE IF NOT EXISTS daily_logs (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (local convention)
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'note', -- heartbeat|fleet|incident|decision|note|social|maintenance
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'hexmem',
  tags TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_daily_logs_day_ts ON daily_logs(day, ts);
CREATE INDEX IF NOT EXISTS idx_daily_logs_kind_ts ON daily_logs(kind, ts);

DROP VIEW IF EXISTS v_daily_log_recent;
CREATE VIEW v_daily_log_recent AS
  SELECT * FROM daily_logs
  ORDER BY ts DESC
  LIMIT 200;

DROP VIEW IF EXISTS v_daily_log_today;
CREATE VIEW v_daily_log_today AS
  SELECT * FROM daily_logs
  WHERE day = date('now','localtime')
  ORDER BY ts DESC;
