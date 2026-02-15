/**
 * OpenClaw Memory (HexMem) Plugin
 *
 * Structured memory backend using HexMem SQLite database.
 * Replaces memory-core with direct HexMem queries.
 * Provides memory_search and memory_get tools compatible with OpenClaw's interface.
 *
 * ENHANCEMENTS (2026-02-15):
 * 1. Smart agent_end: Extract facts + lessons from conversations
 * 2. Decay/reinforcement: Memory maintenance system
 * 3. Contradiction detection: Supersede conflicting facts
 * 4. Proactive recall: Query-based context injection
 * 5. Pattern detection: Auto-generate lessons from recurring events
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface PluginConfig {
  dbPath?: string;
  contextInjection?: {
    enabled?: boolean;
    maxTasks?: number;
    maxEvents?: number;
    includeIdentity?: boolean;
  };
  autoCapture?: {
    enabled?: boolean;
    minTurns?: number;
  };
}

interface SearchResult {
  path: string;
  lines: string;
  score: number;
  table: string;
  id: number;
}

// ============================================================================
// SQLite Helpers
// ============================================================================

function getDbPath(config: PluginConfig): string {
  if (config.dbPath) {
    return config.dbPath.replace(/^~/, homedir());
  }
  return process.env.HEXMEM_DB || join(homedir(), "clawd/hexmem/hexmem.db");
}

function sqliteQuery(dbPath: string, sql: string): string {
  try {
    return execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SQLite query failed: ${msg}`);
  }
}

function sqliteExec(dbPath: string, sql: string): void {
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SQLite exec failed: ${msg}`);
  }
}

function sqliteQueryRows<T>(dbPath: string, sql: string): T[] {
  const output = sqliteQuery(dbPath, sql);
  if (!output || output === "[]") return [];
  try {
    return JSON.parse(output) as T[];
  } catch {
    return [];
  }
}

function escapeSQL(str: string): string {
  return str.replace(/'/g, "''");
}

// ============================================================================
// IMPROVEMENT 1: Smart Fact/Lesson Extraction Patterns
// ============================================================================

interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
}

interface ExtractedLesson {
  domain: string;
  lesson: string;
  context: string;
}

// Patterns for extracting facts (subject/predicate/object triples)
const FACT_PATTERNS: Array<{
  regex: RegExp;
  extract: (match: RegExpMatchArray) => ExtractedFact | null;
}> = [
  // "X is now Y" / "X changed to Y"
  {
    regex: /(?:the\s+)?(\w+(?:\s+\w+)?)\s+(?:is now|changed to|became|is currently)\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      subject: m[1].trim(),
      predicate: "current_state",
      object: m[2].trim(),
    }),
  },
  // "X changed from Y to Z"
  {
    regex: /(\w+(?:\s+\w+)?)\s+changed\s+from\s+.+?\s+to\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      subject: m[1].trim(),
      predicate: "current_state",
      object: m[2].trim(),
    }),
  },
  // "remember that X"
  {
    regex: /remember\s+that\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => {
      const content = m[1].trim();
      // Try to parse "X is Y" within the remembered content
      const isMatch = content.match(/^(\w+(?:\s+\w+)?)\s+(?:is|are|has|have)\s+(.+)$/i);
      if (isMatch) {
        return {
          subject: isMatch[1].trim(),
          predicate: "is",
          object: isMatch[2].trim(),
        };
      }
      return {
        subject: "note",
        predicate: "remember",
        object: content,
      };
    },
  },
  // "X uses Y" / "X prefers Y"
  {
    regex: /(\w+(?:\s+\w+)?)\s+(uses|prefers|requires|needs|has|runs|connects to)\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      subject: m[1].trim(),
      predicate: m[2].toLowerCase(),
      object: m[3].trim(),
    }),
  },
  // "my X is Y" / "the X is Y"
  {
    regex: /(?:my|the|our)\s+(\w+(?:\s+\w+)?)\s+(?:is|are)\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      subject: m[1].trim(),
      predicate: "is",
      object: m[2].trim(),
    }),
  },
];

// Patterns for extracting lessons
const LESSON_PATTERNS: Array<{
  regex: RegExp;
  extract: (match: RegExpMatchArray) => ExtractedLesson | null;
}> = [
  // "learned that X" / "discovered that X"
  {
    regex: /(?:I\s+)?(?:learned|discovered|realized|found out)\s+that\s+(.+?)(?:\.|!|$)/gi,
    extract: (m) => ({
      domain: "general",
      lesson: m[1].trim(),
      context: "conversation",
    }),
  },
  // "the issue was X" / "the problem was X"
  {
    regex: /the\s+(?:issue|problem|bug|error|cause)\s+was\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      domain: "debugging",
      lesson: `Issue root cause: ${m[1].trim()}`,
      context: "troubleshooting",
    }),
  },
  // "turns out X"
  {
    regex: /turns\s+out\s+(?:that\s+)?(.+?)(?:\.|!|$)/gi,
    extract: (m) => ({
      domain: "general",
      lesson: m[1].trim(),
      context: "discovery",
    }),
  },
  // "the fix was X" / "the solution was X"
  {
    regex: /the\s+(?:fix|solution|answer|resolution)\s+(?:was|is)\s+(.+?)(?:\.|,|$)/gi,
    extract: (m) => ({
      domain: "debugging",
      lesson: `Solution: ${m[1].trim()}`,
      context: "problem-solving",
    }),
  },
  // "never do X" / "always do X"
  {
    regex: /(?:you\s+should\s+)?(?:never|always)\s+(.+?)(?:\.|!|$)/gi,
    extract: (m) => ({
      domain: "best-practices",
      lesson: m[0].trim(),
      context: "guidance",
    }),
  },
  // "important: X" / "note: X"
  {
    regex: /(?:important|note|reminder|tip):\s*(.+?)(?:\.|!|$)/gi,
    extract: (m) => ({
      domain: "notes",
      lesson: m[1].trim(),
      context: "annotation",
    }),
  },
];

function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const pattern of FACT_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.regex.lastIndex = 0; // Reset regex state
    while ((match = pattern.regex.exec(text)) !== null) {
      const fact = pattern.extract(match);
      if (fact && fact.subject.length > 1 && fact.object.length > 1) {
        // Avoid duplicates
        const exists = facts.some(
          (f) =>
            f.subject.toLowerCase() === fact.subject.toLowerCase() &&
            f.predicate === fact.predicate,
        );
        if (!exists) {
          facts.push(fact);
        }
      }
    }
  }
  return facts.slice(0, 5); // Limit to 5 facts per session
}

function extractLessons(text: string): ExtractedLesson[] {
  const lessons: ExtractedLesson[] = [];
  for (const pattern of LESSON_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(text)) !== null) {
      const lesson = pattern.extract(match);
      if (lesson && lesson.lesson.length > 5) {
        const exists = lessons.some(
          (l) => l.lesson.toLowerCase() === lesson.lesson.toLowerCase(),
        );
        if (!exists) {
          lessons.push(lesson);
        }
      }
    }
  }
  return lessons.slice(0, 3); // Limit to 3 lessons per session
}

// ============================================================================
// IMPROVEMENT 3: Contradiction Detection Helper
// ============================================================================

interface ExistingFact {
  id: number;
  object_text: string;
}

function checkForContradiction(
  dbPath: string,
  subject: string,
  predicate: string,
): ExistingFact | null {
  const subjectEsc = escapeSQL(subject.toLowerCase());
  const predicateEsc = escapeSQL(predicate.toLowerCase());

  const sql = `
    SELECT id, object_text
    FROM facts
    WHERE status = 'active'
      AND LOWER(COALESCE(subject_text, '')) = '${subjectEsc}'
      AND LOWER(predicate) = '${predicateEsc}'
    LIMIT 1
  `;

  const rows = sqliteQueryRows<ExistingFact>(dbPath, sql);
  return rows.length > 0 ? rows[0] : null;
}

function supersedeFact(
  dbPath: string,
  oldFactId: number,
  newObject: string,
  source: string,
): number {
  const objectEsc = escapeSQL(newObject);
  const sourceEsc = escapeSQL(source);

  // Insert new fact based on old one
  const insertSql = `
    INSERT INTO facts (subject_entity_id, subject_text, predicate, object_text, source, status, last_accessed_at)
    SELECT subject_entity_id, subject_text, predicate, '${objectEsc}', '${sourceEsc}', 'active', datetime('now')
    FROM facts WHERE id = ${oldFactId}
  `;
  sqliteExec(dbPath, insertSql);

  // Get the new fact ID
  const newIdRows = sqliteQueryRows<{ id: number }>(
    dbPath,
    "SELECT last_insert_rowid() as id",
  );
  const newId = newIdRows[0]?.id ?? 0;

  // Mark old fact as superseded
  const updateSql = `
    UPDATE facts
    SET status = 'superseded',
        superseded_by = ${newId},
        valid_until = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ${oldFactId}
  `;
  sqliteExec(dbPath, updateSql);

  return newId;
}

function insertFact(
  dbPath: string,
  subject: string,
  predicate: string,
  object: string,
  source: string,
): void {
  const subjectEsc = escapeSQL(subject);
  const predicateEsc = escapeSQL(predicate);
  const objectEsc = escapeSQL(object);
  const sourceEsc = escapeSQL(source);

  const sql = `
    INSERT INTO facts (subject_text, predicate, object_text, source, status, last_accessed_at)
    VALUES ('${subjectEsc}', '${predicateEsc}', '${objectEsc}', '${sourceEsc}', 'active', datetime('now'))
  `;
  sqliteExec(dbPath, sql);
}

function insertLesson(
  dbPath: string,
  domain: string,
  lesson: string,
  context: string,
): void {
  const domainEsc = escapeSQL(domain);
  const lessonEsc = escapeSQL(lesson);
  const contextEsc = escapeSQL(context);

  const sql = `
    INSERT INTO lessons (domain, lesson, context)
    VALUES ('${domainEsc}', '${lessonEsc}', '${contextEsc}')
  `;
  sqliteExec(dbPath, sql);
}

// ============================================================================
// IMPROVEMENT 2: Decay/Reinforcement System
// ============================================================================

function runMemoryMaintenance(dbPath: string, logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }): string {
  const results: string[] = [];

  try {
    // 1. Decay facts not accessed in >7 days (multiply strength by 0.95)
    const decay7Sql = `
      UPDATE facts
      SET memory_strength = memory_strength * 0.95,
          updated_at = datetime('now')
      WHERE status = 'active'
        AND last_accessed_at IS NOT NULL
        AND JULIANDAY('now') - JULIANDAY(last_accessed_at) > 7
        AND JULIANDAY('now') - JULIANDAY(last_accessed_at) <= 30
    `;
    sqliteExec(dbPath, decay7Sql);
    const decay7Count = sqliteQueryRows<{ changes: number }>(dbPath, "SELECT changes() as changes")[0]?.changes ?? 0;
    if (decay7Count > 0) {
      results.push(`Decayed ${decay7Count} facts (7+ days, *0.95)`);
    }

    // 2. Decay facts not accessed in >30 days (multiply strength by 0.8)
    const decay30Sql = `
      UPDATE facts
      SET memory_strength = memory_strength * 0.8,
          updated_at = datetime('now')
      WHERE status = 'active'
        AND last_accessed_at IS NOT NULL
        AND JULIANDAY('now') - JULIANDAY(last_accessed_at) > 30
    `;
    sqliteExec(dbPath, decay30Sql);
    const decay30Count = sqliteQueryRows<{ changes: number }>(dbPath, "SELECT changes() as changes")[0]?.changes ?? 0;
    if (decay30Count > 0) {
      results.push(`Decayed ${decay30Count} facts (30+ days, *0.8)`);
    }

    // 3. Boost frequently accessed facts (access_count > 10, strength * 1.1, cap at 10.0)
    const boostSql = `
      UPDATE facts
      SET memory_strength = MIN(10.0, memory_strength * 1.1),
          updated_at = datetime('now')
      WHERE status = 'active'
        AND access_count > 10
        AND memory_strength < 10.0
    `;
    sqliteExec(dbPath, boostSql);
    const boostCount = sqliteQueryRows<{ changes: number }>(dbPath, "SELECT changes() as changes")[0]?.changes ?? 0;
    if (boostCount > 0) {
      results.push(`Boosted ${boostCount} frequently-accessed facts (*1.1)`);
    }

    // 4. Mark facts with memory_strength < 0.1 as decayed
    const decaySql = `
      UPDATE facts
      SET status = 'decayed',
          updated_at = datetime('now')
      WHERE status = 'active'
        AND memory_strength < 0.1
    `;
    sqliteExec(dbPath, decaySql);
    const decayedCount = sqliteQueryRows<{ changes: number }>(dbPath, "SELECT changes() as changes")[0]?.changes ?? 0;
    if (decayedCount > 0) {
      results.push(`Marked ${decayedCount} weak facts as decayed`);
    }

    // Update last maintenance timestamp
    const timestampSql = `
      INSERT INTO kv_store (namespace, key, value, updated_at)
      VALUES ('hexmem', 'last_maintenance', datetime('now'), datetime('now'))
      ON CONFLICT(namespace, key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')
    `;
    sqliteExec(dbPath, timestampSql);

    if (results.length === 0) {
      results.push("No maintenance actions needed");
    }

    logger?.info?.(`memory-hexmem: maintenance complete - ${results.join(", ")}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`Error: ${msg}`);
    logger?.warn?.(`memory-hexmem: maintenance error - ${msg}`);
  }

  return results.join("\n");
}

function shouldRunMaintenance(dbPath: string): boolean {
  try {
    const sql = `
      SELECT value FROM kv_store
      WHERE namespace = 'hexmem' AND key = 'last_maintenance'
    `;
    const rows = sqliteQueryRows<{ value: string }>(dbPath, sql);
    if (rows.length === 0) return true;

    const lastRun = new Date(rows[0].value);
    const now = new Date();
    const hoursSinceRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);
    return hoursSinceRun >= 24; // Run once per day
  } catch {
    return true;
  }
}

// ============================================================================
// IMPROVEMENT 5: Pattern Detection
// ============================================================================

function detectAndRecordPatterns(dbPath: string, logger?: { info?: (msg: string) => void }): string {
  const results: string[] = [];

  try {
    // Query events from last 7 days, group by category + event_type
    const sql = `
      SELECT category, event_type, COUNT(*) as count
      FROM events
      WHERE occurred_at >= datetime('now', '-7 days')
      GROUP BY category, event_type
      HAVING COUNT(*) >= 3
      ORDER BY count DESC
      LIMIT 5
    `;
    const patterns = sqliteQueryRows<{ category: string; event_type: string; count: number }>(dbPath, sql);

    for (const pattern of patterns) {
      const lessonText = `Recurring pattern: '${pattern.event_type}' happened ${pattern.count} times this week in category '${pattern.category}'`;

      // Check if similar lesson already exists
      const checkSql = `
        SELECT id FROM lessons
        WHERE domain = 'patterns'
          AND lesson LIKE '%${escapeSQL(pattern.event_type)}%'
          AND lesson LIKE '%${escapeSQL(pattern.category)}%'
          AND created_at >= datetime('now', '-7 days')
        LIMIT 1
      `;
      const existing = sqliteQueryRows<{ id: number }>(dbPath, checkSql);

      if (existing.length === 0) {
        insertLesson(dbPath, "patterns", lessonText, `Auto-detected from ${pattern.count} events`);
        results.push(`Pattern: ${pattern.event_type}/${pattern.category} (${pattern.count}x)`);
      }
    }

    // Update last pattern detection timestamp
    const timestampSql = `
      INSERT INTO kv_store (namespace, key, value, updated_at)
      VALUES ('hexmem', 'last_pattern_detection', datetime('now'), datetime('now'))
      ON CONFLICT(namespace, key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')
    `;
    sqliteExec(dbPath, timestampSql);

    if (results.length > 0) {
      logger?.info?.(`memory-hexmem: detected ${results.length} patterns`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`Pattern detection error: ${msg}`);
  }

  return results.length > 0 ? results.join("\n") : "No new patterns detected";
}

function shouldRunPatternDetection(dbPath: string): boolean {
  try {
    const sql = `
      SELECT value FROM kv_store
      WHERE namespace = 'hexmem' AND key = 'last_pattern_detection'
    `;
    const rows = sqliteQueryRows<{ value: string }>(dbPath, sql);
    if (rows.length === 0) return true;

    const lastRun = new Date(rows[0].value);
    const now = new Date();
    const hoursSinceRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);
    return hoursSinceRun >= 24;
  } catch {
    return true;
  }
}

// ============================================================================
// IMPROVEMENT 4: Proactive Recall Helper
// ============================================================================

function proactiveRecall(dbPath: string, userMessage: string, limit = 3): string[] {
  // Extract keywords from user message (simple word extraction)
  const words = userMessage
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  if (words.length === 0) return [];

  const results: string[] = [];

  // Search facts
  for (const word of words) {
    const wordEsc = escapeSQL(word);
    const factsSql = `
      SELECT COALESCE(subject_text, '') || ' ' || predicate || ' ' || COALESCE(object_text, '') as content
      FROM facts
      WHERE status = 'active'
        AND (LOWER(subject_text) LIKE '%${wordEsc}%'
             OR LOWER(object_text) LIKE '%${wordEsc}%'
             OR LOWER(predicate) LIKE '%${wordEsc}%')
      ORDER BY memory_strength DESC, last_accessed_at DESC NULLS LAST
      LIMIT 2
    `;
    const facts = sqliteQueryRows<{ content: string }>(dbPath, factsSql);
    for (const f of facts) {
      if (f.content.trim() && !results.includes(f.content)) {
        results.push(`[fact] ${f.content}`);
      }
    }
  }

  // Search lessons
  for (const word of words) {
    const wordEsc = escapeSQL(word);
    const lessonsSql = `
      SELECT '[' || domain || '] ' || lesson as content
      FROM lessons
      WHERE (valid_until IS NULL OR valid_until > datetime('now'))
        AND (LOWER(lesson) LIKE '%${wordEsc}%' OR LOWER(context) LIKE '%${wordEsc}%')
      ORDER BY confidence DESC, times_applied DESC
      LIMIT 2
    `;
    const lessons = sqliteQueryRows<{ content: string }>(dbPath, lessonsSql);
    for (const l of lessons) {
      if (l.content.trim() && !results.includes(l.content)) {
        results.push(`[lesson] ${l.content}`);
      }
    }
  }

  // Search recent events
  for (const word of words) {
    const wordEsc = escapeSQL(word);
    const eventsSql = `
      SELECT '[' || event_type || '/' || category || '] ' || summary as content
      FROM events
      WHERE LOWER(summary) LIKE '%${wordEsc}%'
        AND occurred_at >= datetime('now', '-7 days')
      ORDER BY occurred_at DESC
      LIMIT 2
    `;
    const events = sqliteQueryRows<{ content: string }>(dbPath, eventsSql);
    for (const e of events) {
      if (e.content.trim() && !results.includes(e.content)) {
        results.push(`[event] ${e.content}`);
      }
    }
  }

  return results.slice(0, limit);
}

// ============================================================================
// Search Implementation
// ============================================================================

function searchTable(
  dbPath: string,
  table: string,
  query: string,
  limit: number,
): SearchResult[] {
  const escaped = escapeSQL(query.toLowerCase());

  let sql: string;
  let contentField: string;
  let idField = "id";

  switch (table) {
    case "events":
      contentField = "summary || ' ' || COALESCE(details, '')";
      sql = `
        SELECT id, summary, details, category, event_type,
               datetime(occurred_at) as occurred_at
        FROM events
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
        ORDER BY occurred_at DESC
        LIMIT ${limit}
      `;
      break;

    case "lessons":
      contentField = "lesson || ' ' || COALESCE(context, '')";
      sql = `
        SELECT id, domain, lesson, context, confidence
        FROM lessons
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
           AND (valid_until IS NULL OR valid_until > datetime('now'))
        ORDER BY confidence DESC, created_at DESC
        LIMIT ${limit}
      `;
      break;

    case "facts":
      contentField =
        "COALESCE(subject_text, '') || ' ' || predicate || ' ' || COALESCE(object_text, '')";
      sql = `
        SELECT f.id,
               COALESCE(e.name, f.subject_text) as subject,
               f.predicate, f.object_text, f.confidence
        FROM facts f
        LEFT JOIN entities e ON f.subject_entity_id = e.id
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
          AND f.status = 'active'
        ORDER BY f.last_accessed_at DESC NULLS LAST, f.created_at DESC
        LIMIT ${limit}
      `;
      break;

    case "tasks":
      contentField = "title || ' ' || COALESCE(description, '')";
      sql = `
        SELECT id, title, description, priority, status,
               COALESCE(due_at, '') as due_at
        FROM tasks
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
          priority DESC
        LIMIT ${limit}
      `;
      break;

    case "interactions":
      contentField =
        "COALESCE(summary, '') || ' ' || COALESCE(counterparty_name, '')";
      sql = `
        SELECT id, channel, counterparty_name, summary, sentiment,
               datetime(occurred_at) as occurred_at
        FROM interactions
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
        ORDER BY occurred_at DESC
        LIMIT ${limit}
      `;
      break;

    case "seeds":
      contentField =
        "seed_text || ' ' || COALESCE(emotional_gist, '') || ' ' || seed_type";
      sql = `
        SELECT id, seed_type, seed_text, emotional_gist
        FROM memory_seeds
        WHERE LOWER(${contentField}) LIKE '%${escaped}%'
        ORDER BY times_expanded DESC, created_at DESC
        LIMIT ${limit}
      `;
      break;

    default:
      return [];
  }

  const rows = sqliteQueryRows<Record<string, unknown>>(dbPath, sql);

  return rows.map((row, idx) => {
    const id = row[idField] as number;
    let preview: string;
    let score = 1 - idx * 0.05; // Simple ranking by position

    switch (table) {
      case "events":
        preview = `[${row.event_type}/${row.category}] ${row.summary}`;
        if (row.details) preview += ` — ${String(row.details).slice(0, 100)}`;
        break;
      case "lessons":
        preview = `[${row.domain}] ${row.lesson}`;
        break;
      case "facts":
        preview = `${row.subject} ${row.predicate} ${row.object_text}`;
        break;
      case "tasks":
        preview = `[${row.status}] ${row.title}`;
        if (row.due_at) preview += ` (due: ${row.due_at})`;
        break;
      case "interactions":
        preview = `[${row.channel}] ${row.counterparty_name}: ${row.summary}`;
        break;
      case "seeds":
        preview = `[${row.seed_type}] ${String(row.seed_text).slice(0, 150)}`;
        break;
      default:
        preview = JSON.stringify(row);
    }

    return {
      path: `hexmem://${table}/${id}`,
      lines: preview,
      score: Math.max(0.1, score),
      table,
      id,
    };
  });
}

function memorySearch(
  dbPath: string,
  query: string,
  maxResults: number,
  minScore: number,
): SearchResult[] {
  const tables = ["events", "lessons", "facts", "tasks", "interactions", "seeds"];
  const perTable = Math.ceil(maxResults / tables.length) + 2;

  const allResults: SearchResult[] = [];

  for (const table of tables) {
    try {
      const results = searchTable(dbPath, table, query, perTable);
      allResults.push(...results);
    } catch {
      // Skip tables that fail (might not exist)
    }
  }

  // Sort by score and limit
  return allResults
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ============================================================================
// Get Implementation
// ============================================================================

function memoryGet(
  dbPath: string,
  path: string,
  from?: number,
  lines?: number,
): string {
  // Parse hexmem:// URI
  const match = path.match(/^hexmem:\/\/(\w+)(?:\/(.+))?$/);
  if (!match) {
    return `Invalid path format: ${path}. Expected hexmem://<table>[/<id-or-filter>]`;
  }

  const [, table, param] = match;
  let sql: string;

  switch (table) {
    case "lessons":
      if (param && /^\d+$/.test(param)) {
        sql = `SELECT id, domain, lesson, context, confidence, times_applied,
                      datetime(created_at) as created_at
               FROM lessons WHERE id = ${param}`;
      } else if (param) {
        const domain = escapeSQL(param);
        sql = `SELECT id, domain, lesson, confidence
               FROM lessons
               WHERE domain = '${domain}' AND (valid_until IS NULL OR valid_until > datetime('now'))
               ORDER BY confidence DESC LIMIT ${lines || 20}`;
      } else {
        sql = `SELECT id, domain, lesson, confidence
               FROM lessons
               WHERE valid_until IS NULL OR valid_until > datetime('now')
               ORDER BY confidence DESC LIMIT ${lines || 20}`;
      }
      break;

    case "facts":
      if (param && /^\d+$/.test(param)) {
        sql = `SELECT f.id, COALESCE(e.name, f.subject_text) as subject,
                      f.predicate, f.object_text, f.confidence, f.source
               FROM facts f
               LEFT JOIN entities e ON f.subject_entity_id = e.id
               WHERE f.id = ${param}`;
      } else {
        sql = `SELECT f.id, COALESCE(e.name, f.subject_text) as subject,
                      f.predicate, f.object_text, f.confidence
               FROM facts f
               LEFT JOIN entities e ON f.subject_entity_id = e.id
               WHERE f.status = 'active'
               ORDER BY f.last_accessed_at DESC NULLS LAST
               LIMIT ${lines || 30}`;
      }
      break;

    case "tasks":
      if (param === "pending" || param === "active") {
        sql = `SELECT id, title, priority, COALESCE(due_at, '') as due_at
               FROM tasks
               WHERE status IN ('pending', 'in_progress')
               ORDER BY priority DESC, due_at ASC
               LIMIT ${lines || 20}`;
      } else if (param === "all") {
        sql = `SELECT id, title, status, priority
               FROM tasks ORDER BY created_at DESC LIMIT ${lines || 30}`;
      } else if (param && /^\d+$/.test(param)) {
        sql = `SELECT id, title, description, status, priority, due_at,
                      datetime(created_at) as created_at
               FROM tasks WHERE id = ${param}`;
      } else {
        sql = `SELECT id, title, priority, COALESCE(due_at, '') as due_at
               FROM tasks WHERE status IN ('pending', 'in_progress')
               ORDER BY priority DESC LIMIT ${lines || 20}`;
      }
      break;

    case "events":
      if (param === "recent") {
        const limit = lines || 10;
        sql = `SELECT id, datetime(occurred_at) as occurred_at,
                      event_type, category, summary
               FROM events ORDER BY occurred_at DESC LIMIT ${limit}`;
      } else if (param === "today") {
        sql = `SELECT id, substr(occurred_at, 12, 5) as time,
                      event_type, category, summary
               FROM events
               WHERE date(occurred_at) = date('now')
               ORDER BY occurred_at DESC`;
      } else if (param && /^\d+$/.test(param)) {
        sql = `SELECT id, datetime(occurred_at) as occurred_at,
                      event_type, category, summary, details
               FROM events WHERE id = ${param}`;
      } else {
        sql = `SELECT id, datetime(occurred_at) as occurred_at,
                      event_type, category, summary
               FROM events ORDER BY occurred_at DESC LIMIT ${lines || 20}`;
      }
      break;

    case "interactions":
      if (param && /^\d+$/.test(param)) {
        sql = `SELECT id, channel, counterparty_name, summary, sentiment,
                      datetime(occurred_at) as occurred_at
               FROM interactions WHERE id = ${param}`;
      } else {
        sql = `SELECT id, channel, counterparty_name, summary,
                      datetime(occurred_at) as occurred_at
               FROM interactions ORDER BY occurred_at DESC LIMIT ${lines || 20}`;
      }
      break;

    case "seeds":
      if (param && /^\d+$/.test(param)) {
        sql = `SELECT id, seed_type, seed_text, emotional_gist, themes
               FROM memory_seeds WHERE id = ${param}`;
      } else {
        sql = `SELECT id, seed_type, substr(seed_text, 1, 100) as seed_preview,
                      emotional_gist
               FROM memory_seeds ORDER BY created_at DESC LIMIT ${lines || 15}`;
      }
      break;

    case "identity":
      sql = `SELECT attribute, value FROM identity WHERE public = 1`;
      break;

    default:
      return `Unknown table: ${table}. Supported: events, lessons, facts, tasks, interactions, seeds, identity`;
  }

  const rows = sqliteQueryRows<Record<string, unknown>>(dbPath, sql);
  if (rows.length === 0) {
    return `No results found for: ${path}`;
  }

  // Format output
  const output: string[] = [];
  for (const row of rows) {
    const parts: string[] = [];
    for (const [key, val] of Object.entries(row)) {
      if (val !== null && val !== "") {
        parts.push(`${key}: ${val}`);
      }
    }
    output.push(parts.join(" | "));
  }

  return output.join("\n");
}

// ============================================================================
// Context Injection
// ============================================================================

function buildContextInjection(
  dbPath: string,
  config: PluginConfig["contextInjection"],
): string {
  const maxTasks = config?.maxTasks ?? 5;
  const maxEvents = config?.maxEvents ?? 3;
  const includeIdentity = config?.includeIdentity ?? true;

  const sections: string[] = [];

  // Pending tasks
  try {
    const tasks = sqliteQueryRows<{ id: number; title: string; priority: number }>(
      dbPath,
      `SELECT id, title, priority FROM tasks
       WHERE status IN ('pending', 'in_progress')
       ORDER BY priority DESC LIMIT ${maxTasks}`,
    );
    if (tasks.length > 0) {
      const taskList = tasks
        .map((t) => `- [${t.priority}] ${t.title}`)
        .join("\n");
      sections.push(`**Pending Tasks:**\n${taskList}`);
    }
  } catch {
    /* ignore */
  }

  // Identity summary
  if (includeIdentity) {
    try {
      const identity = sqliteQueryRows<{ attribute: string; value: string }>(
        dbPath,
        `SELECT attribute, value FROM identity
         WHERE public = 1 AND attribute IN ('name', 'role', 'npub', 'lightning_address')`,
      );
      if (identity.length > 0) {
        const idParts = identity.map((i) => `${i.attribute}: ${i.value}`).join(", ");
        sections.push(`**Identity:** ${idParts}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Recent significant events
  try {
    const events = sqliteQueryRows<{
      occurred_at: string;
      event_type: string;
      summary: string;
    }>(
      dbPath,
      `SELECT datetime(occurred_at) as occurred_at, event_type, summary
       FROM events
       WHERE significance >= 6
       ORDER BY occurred_at DESC LIMIT ${maxEvents}`,
    );
    if (events.length > 0) {
      const eventList = events
        .map((e) => `- [${e.occurred_at}] ${e.summary}`)
        .join("\n");
      sections.push(`**Recent Events:**\n${eventList}`);
    }
  } catch {
    /* ignore */
  }

  if (sections.length === 0) {
    return "";
  }

  return `<hexmem-context>\n${sections.join("\n\n")}\n</hexmem-context>`;
}

// ============================================================================
// Auto-capture
// ============================================================================

function captureInteraction(
  dbPath: string,
  summary: string,
  turnCount: number,
): void {
  const escaped = escapeSQL(summary.slice(0, 500));
  const sql = `INSERT INTO interactions (channel, counterparty_name, summary, sentiment)
               VALUES ('openclaw', 'user', '${escaped}', 'neutral')`;
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    /* ignore capture failures */
  }

  // Also log as event
  const eventSql = `INSERT INTO events (event_type, category, summary, significance)
                    VALUES ('session', 'openclaw', 'Session with ${turnCount} turns: ${escaped}', 4)`;
  try {
    execFileSync("sqlite3", [dbPath, eventSql], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryHexmemPlugin = {
  id: "memory-hexmem",
  name: "Memory (HexMem)",
  description: "HexMem-backed structured memory with semantic search",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig || {}) as PluginConfig;
    const dbPath = getDbPath(cfg);

    api.logger.info(`memory-hexmem: plugin registered (db: ${dbPath})`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search through HexMem structured memory. Searches events, lessons, facts, tasks, interactions, and seeds. Returns matching entries with hexmem:// URIs for follow-up retrieval.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          maxResults: Type.Optional(
            Type.Number({ description: "Max results (default: 10)" }),
          ),
          minScore: Type.Optional(
            Type.Number({ description: "Min relevance score 0-1 (default: 0.1)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            maxResults = 10,
            minScore = 0.1,
          } = params as { query: string; maxResults?: number; minScore?: number };

          try {
            const results = memorySearch(dbPath, query, maxResults, minScore);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No memories found matching query." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map(
                (r) => `- ${r.path} (${(r.score * 100).toFixed(0)}%): ${r.lines}`,
              )
              .join("\n");

            return {
              content: [
                { type: "text", text: `Found ${results.length} results:\n\n${text}` },
              ],
              details: {
                count: results.length,
                results: results.map((r) => ({
                  path: r.path,
                  lines: r.lines,
                  score: r.score,
                })),
              },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Search failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "memory_search" },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description:
          "Retrieve structured data from HexMem by path. Supports hexmem://<table>/<id> for specific items, or hexmem://<table>/<filter> for filtered lists. Tables: events, lessons, facts, tasks, interactions, seeds, identity. Filters: events/recent, events/today, tasks/pending, facts (all active).",
        parameters: Type.Object({
          path: Type.String({
            description:
              "HexMem path (e.g., hexmem://lessons/42, hexmem://tasks/pending, hexmem://events/recent)",
          }),
          from: Type.Optional(
            Type.Number({ description: "Start offset (not used for HexMem)" }),
          ),
          lines: Type.Optional(Type.Number({ description: "Max items to return" })),
        }),
        async execute(_toolCallId, params) {
          const { path, from, lines } = params as {
            path: string;
            from?: number;
            lines?: number;
          };

          try {
            const result = memoryGet(dbPath, path, from, lines);
            return {
              content: [{ type: "text", text: result }],
              details: { path },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Get failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "memory_get" },
    );

    // ========================================================================
    // IMPROVEMENT 2: memory_maintain tool
    // ========================================================================
    api.registerTool(
      {
        name: "memory_maintain",
        label: "Memory Maintenance",
        description:
          "Run memory maintenance: decay old facts, boost frequently accessed ones, mark weak facts as decayed. Can be called manually or runs automatically once per day.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const result = runMemoryMaintenance(dbPath, api.logger);
            return {
              content: [{ type: "text", text: `Memory maintenance complete:\n${result}` }],
              details: { success: true },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Maintenance failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "memory_maintain" },
    );

    // ========================================================================
    // IMPROVEMENT 5: memory_patterns tool
    // ========================================================================
    api.registerTool(
      {
        name: "memory_patterns",
        label: "Memory Pattern Detection",
        description:
          "Detect recurring patterns in events from the last 7 days and auto-generate lessons. Patterns are event_types that occur 3+ times in a category.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const result = detectAndRecordPatterns(dbPath, api.logger);
            return {
              content: [{ type: "text", text: `Pattern detection complete:\n${result}` }],
              details: { success: true },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Pattern detection failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "memory_patterns" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // IMPROVEMENT 4: Enhanced before_agent_start with proactive recall
    const contextEnabled = cfg.contextInjection?.enabled ?? true;
    if (contextEnabled) {
      api.on("before_agent_start", async (event) => {
        try {
          const sections: string[] = [];

          // Standard context injection
          const context = buildContextInjection(dbPath, cfg.contextInjection);
          if (context) {
            sections.push(context);
          }

          // IMPROVEMENT 2 & 5: Run periodic maintenance and pattern detection
          if (shouldRunMaintenance(dbPath)) {
            runMemoryMaintenance(dbPath, api.logger);
          }
          if (shouldRunPatternDetection(dbPath)) {
            detectAndRecordPatterns(dbPath, api.logger);
          }

          // IMPROVEMENT 4: Proactive recall based on user message
          // Check if there's a user message/prompt in the event
          const userMessage = event.prompt || (event as Record<string, unknown>).userMessage as string | undefined;
          if (userMessage && typeof userMessage === "string" && userMessage.length > 5) {
            const recalled = proactiveRecall(dbPath, userMessage, 3);
            if (recalled.length > 0) {
              const recallContext = `<hexmem-recall>\n**Relevant memories for this query:**\n${recalled.map((r) => `- ${r}`).join("\n")}\n</hexmem-recall>`;
              sections.push(recallContext);
              api.logger.info?.(`memory-hexmem: proactively recalled ${recalled.length} items`);
            }
          }

          if (sections.length > 0) {
            api.logger.info?.("memory-hexmem: injecting context");
            return { prependContext: sections.join("\n\n") };
          }
        } catch (err) {
          api.logger.warn?.(
            `memory-hexmem: context injection failed: ${String(err)}`,
          );
        }
        return undefined;
      });
    }

    // IMPROVEMENT 1 & 3: Enhanced agent_end with fact/lesson extraction and contradiction detection
    const captureEnabled = cfg.autoCapture?.enabled ?? true;
    const minTurns = cfg.autoCapture?.minTurns ?? 2;

    if (captureEnabled) {
      api.on("agent_end", async (event) => {
        if (!event.success) return;

        // Count turns
        const messages = event.messages as unknown[];
        if (!messages || !Array.isArray(messages)) return;

        const userTurns = messages.filter((m) => {
          if (!m || typeof m !== "object") return false;
          return (m as Record<string, unknown>).role === "user";
        }).length;

        if (userTurns < minTurns) return;

        // Build combined text from conversation for analysis
        let combinedText = "";
        let summary = "OpenClaw session";

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, unknown>;
          if (!msg) continue;

          const content = msg.content;
          let textContent = "";

          if (typeof content === "string") {
            textContent = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                (block as Record<string, unknown>).type === "text"
              ) {
                textContent += String((block as Record<string, unknown>).text || "") + " ";
              }
            }
          }

          if (textContent) {
            combinedText += textContent + "\n";
            if (msg.role === "user" && summary === "OpenClaw session") {
              summary = textContent.slice(0, 200);
            }
          }
        }

        try {
          // ================================================================
          // IMPROVEMENT 1: Extract facts and lessons from conversation
          // ================================================================
          const extractedFacts = extractFacts(combinedText);
          const extractedLessons = extractLessons(combinedText);

          let factsInserted = 0;
          let factsUpdated = 0;
          let lessonsInserted = 0;

          // Process extracted facts with contradiction detection
          for (const fact of extractedFacts) {
            // IMPROVEMENT 3: Check for contradictions
            const existing = checkForContradiction(dbPath, fact.subject, fact.predicate);

            if (existing) {
              // Contradiction found - check if value actually differs
              if (existing.object_text.toLowerCase() !== fact.object.toLowerCase()) {
                supersedeFact(dbPath, existing.id, fact.object, "conversation-update");
                factsUpdated++;
                api.logger.info?.(
                  `memory-hexmem: superseded fact ${existing.id}: "${fact.subject} ${fact.predicate}" changed from "${existing.object_text}" to "${fact.object}"`,
                );
              }
              // If same value, skip (no change needed)
            } else {
              // No existing fact, insert new one
              insertFact(dbPath, fact.subject, fact.predicate, fact.object, "conversation");
              factsInserted++;
            }
          }

          // Process extracted lessons (no contradiction detection needed, just avoid duplicates)
          for (const lesson of extractedLessons) {
            // Check for similar lesson
            const checkSql = `
              SELECT id FROM lessons
              WHERE domain = '${escapeSQL(lesson.domain)}'
                AND LOWER(lesson) = '${escapeSQL(lesson.lesson.toLowerCase())}'
              LIMIT 1
            `;
            const existing = sqliteQueryRows<{ id: number }>(dbPath, checkSql);

            if (existing.length === 0) {
              insertLesson(dbPath, lesson.domain, lesson.lesson, lesson.context);
              lessonsInserted++;
            }
          }

          if (factsInserted > 0 || factsUpdated > 0 || lessonsInserted > 0) {
            api.logger.info?.(
              `memory-hexmem: extracted ${factsInserted} new facts, ${factsUpdated} updated, ${lessonsInserted} lessons`,
            );
          }

          // ================================================================
          // Original: Capture interaction summary
          // ================================================================
          captureInteraction(dbPath, summary, userTurns);
          api.logger.info?.(`memory-hexmem: captured session (${userTurns} turns)`);
        } catch (err) {
          api.logger.warn?.(`memory-hexmem: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-hexmem",
      start: () => {
        api.logger.info(`memory-hexmem: initialized (db: ${dbPath})`);
      },
      stop: () => {
        api.logger.info("memory-hexmem: stopped");
      },
    });
  },
};

export default memoryHexmemPlugin;
