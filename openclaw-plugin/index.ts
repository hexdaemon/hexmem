/**
 * OpenClaw Memory (HexMem) Plugin
 *
 * Structured memory backend using HexMem SQLite database.
 * Replaces memory-core with direct HexMem queries.
 * Provides memory_search and memory_get tools compatible with OpenClaw's interface.
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
           AND (status IS NULL OR status = 'active')
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
               WHERE domain = '${domain}' AND (status IS NULL OR status = 'active')
               ORDER BY confidence DESC LIMIT ${lines || 20}`;
      } else {
        sql = `SELECT id, domain, lesson, confidence
               FROM lessons
               WHERE status IS NULL OR status = 'active'
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
    // Lifecycle Hooks
    // ========================================================================

    // Before agent start: inject context
    const contextEnabled = cfg.contextInjection?.enabled ?? true;
    if (contextEnabled) {
      api.on("before_agent_start", async (_event) => {
        try {
          const context = buildContextInjection(dbPath, cfg.contextInjection);
          if (context) {
            api.logger.info?.("memory-hexmem: injecting context");
            return { prependContext: context };
          }
        } catch (err) {
          api.logger.warn?.(
            `memory-hexmem: context injection failed: ${String(err)}`,
          );
        }
        return undefined;
      });
    }

    // Agent end: auto-capture
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

        // Build summary from last user message
        let summary = "OpenClaw session";
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, unknown>;
          if (msg?.role === "user") {
            const content = msg.content;
            if (typeof content === "string") {
              summary = content.slice(0, 200);
              break;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  (block as Record<string, unknown>).type === "text"
                ) {
                  summary = String(
                    (block as Record<string, unknown>).text || "",
                  ).slice(0, 200);
                  break;
                }
              }
            }
            break;
          }
        }

        try {
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
