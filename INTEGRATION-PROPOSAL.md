# HexMem ↔ OpenClaw Memory Integration Proposal

**Date:** 2026-02-15  
**Status:** Draft  
**Author:** Hex (subagent research)

---

## 1. Current Pain Points

### Duplication
- **MEMORY.md + memory/*.md** — narrative files indexed by OpenClaw's built-in `memory-core` plugin (uses `MemoryIndexManager` with embedding-based search over .md files in workspace)
- **HexMem (hexmem.db)** — structured SQLite database with entities, facts, events, lessons, tasks, identity, interactions, plus its own semantic search via `embed.py` + `sqlite-vec`
- Information lives in both places. A lesson logged via `hexmem_lesson` doesn't appear in `memory_search`. A preference noted in MEMORY.md isn't queryable via `hexmem_facts_about`.

### Context Overhead
- Session start loads: MEMORY.md, memory/YYYY-MM-DD.md (×2), plus HexMem queries (`hexmem_pending_tasks`, `hexmem_recent_events`, `hexmem_identity_summary`)
- This burns 2000-5000+ tokens before any user interaction
- Two separate search systems to query when looking for past context

### Maintenance Burden
- Must remember to log to both systems
- No automatic sync — things get stale in one or the other
- Two embedding pipelines: OpenClaw uses OpenAI embeddings (text-embedding-3-small), HexMem uses sentence-transformers locally

---

## 2. Integration Options

### How OpenClaw Memory Actually Works (from source)

OpenClaw has **two memory plugins**:

1. **`memory-core`** — The default. Delegates to `MemoryIndexManager` which:
   - Scans `MEMORY.md`, `memory.md`, and `memory/**/*.md` in workspace
   - Supports a `qmd` backend (external CLI tool) or builtin file indexer
   - Supports **custom paths** via `memory.qmd.paths[]` config
   - Provides `memory_search` and `memory_get` tools to the agent
   - Has embedding support (configurable provider)

2. **`memory-lancedb`** — Alternative plugin using LanceDB vector store with OpenAI embeddings. Provides `memory_recall`, `memory_store`, `memory_forget` tools. Has auto-capture (from user messages) and auto-recall (inject relevant memories before agent starts).

**Key discovery:** `memory-core` with `qmd` backend supports **custom collection paths** and an external search command. The builtin fallback indexes .md files with glob patterns.

**Plugin system:** OpenClaw has a proper plugin SDK with `api.registerTool()`, `api.on("before_agent_start")`, `api.on("agent_end")`, `api.registerCli()`, and `api.registerService()`. Plugins declare `kind: "memory"`.

---

### Option A: HexMem as a qmd-compatible search provider
**Feasibility: ★★★☆☆ (Medium)**

Write a `hexmem-qmd` CLI wrapper that speaks the `qmd` protocol (whatever interface `QmdMemoryManager` expects). Configure OpenClaw to use it via `memory.qmd.command`.

**Pros:** Native integration, single `memory_search` tool queries both .md files and HexMem  
**Cons:** `qmd` protocol is undocumented/internal; would need reverse-engineering the expected I/O format from `qmd-manager-CepfAhrl.js`. Fragile across OpenClaw updates.

---

### Option B: Sync layer — auto-generate .md files from HexMem
**Feasibility: ★★★★★ (Highest)**

A script/cron that exports HexMem data to .md files in `memory/`, so OpenClaw's builtin indexer picks them up naturally.

```
hexmem.db → hexmem-sync.sh → memory/hexmem-facts.md
                             → memory/hexmem-lessons.md  
                             → memory/hexmem-tasks.md
                             → memory/hexmem-recent.md
```

**Pros:**
- Zero changes to OpenClaw — works with existing `memory-core` file indexer
- `memory_search` automatically covers HexMem content
- Simple bash script, trivial to implement
- Can run on cron or as a heartbeat task
- Preserves HexMem as source of truth for structured queries

**Cons:**
- One-way sync (OpenClaw can't write back to HexMem)
- Slight staleness (depends on sync frequency)
- Doesn't eliminate MEMORY.md (but could replace it over time)

---

### Option C: OpenClaw plugin that queries HexMem alongside .md files
**Feasibility: ★★★★☆ (High)**

Write a custom OpenClaw plugin (`memory-hexmem`) using the plugin SDK. Register additional tools (`hexmem_search`, `hexmem_recall`) or hook into `before_agent_start` to inject HexMem context.

```typescript
// extensions/memory-hexmem/index.ts
const plugin = {
  id: "memory-hexmem",
  kind: "memory",
  register(api) {
    api.registerTool({
      name: "hexmem_search",
      async execute(_, { query }) {
        // Shell out to: hexmem_search "query" or python search.py
      }
    });
    
    api.on("before_agent_start", async (event) => {
      // Inject pending tasks, recent events as context
    });
  }
};
```

**Pros:**
- Full control over what/when HexMem data surfaces
- Can use HexMem's own semantic search (sqlite-vec)
- Could auto-inject identity/tasks without explicit queries
- Proper integration, not a hack

**Cons:**
- Need to maintain a TypeScript plugin
- Must install into OpenClaw's extensions directory
- Two `memory_search`-like tools could confuse the agent
- Plugin SDK may change across versions

---

### Option D: Replace one system with the other
**Feasibility: ★★☆☆☆ (Low)**

**D1: Replace HexMem with OpenClaw memory** — Lose structured queries, entities, facts, lessons, identity, tasks, emotional weights, spaced repetition, decay tiers. OpenClaw memory is flat text search. Not viable.

**D2: Replace OpenClaw memory with HexMem** — Disable `memory-core`, use only HexMem. Lose auto-recall injection, auto-capture, and `memory_search`/`memory_get` tools that OpenClaw provides. Would need to rebuild those features in HexMem or a plugin.

**Verdict:** HexMem is far richer. OpenClaw's memory is simpler but has lifecycle hooks. Replacing either loses capabilities.

---

### Option E: MCP server approach
**Feasibility: ★★★☆☆ (Medium)**

Expose HexMem as an MCP server (already partially done via hexswarm's `agent_memory` tool). OpenClaw could connect to it as an MCP tool provider.

**Pros:** Clean separation, standard protocol  
**Cons:** OpenClaw's MCP integration status unknown; adds network hop; hexswarm MCP is already partially doing this but tightly coupled to swarm coordination.

---

### Option F: Hybrid — Option B + gradual migration to HexMem as primary
**Feasibility: ★★★★★ (Highest)**

1. **Immediate:** Sync script (Option B) to bridge the gap
2. **Short-term:** Stop writing to MEMORY.md manually; let HexMem be the source of truth
3. **Medium-term:** Build Option C plugin for richer integration
4. **Long-term:** MEMORY.md becomes auto-generated from HexMem, not hand-edited

---

## 3. RECOMMENDED: Option G — HexMem Replaces .md Memory (Plugin)

### Vision

HexMem becomes the **sole memory backend**. No more MEMORY.md, no more memory/*.md files. A custom OpenClaw plugin (`memory-hexmem`) replaces `memory-core` entirely, routing `memory_search` and `memory_get` through HexMem's SQLite database.

### Feasibility Assessment

From Codex's source exploration of OpenClaw internals:

1. **Can a plugin replace memory-core's tools?** — **Yes.** OpenClaw's plugin SDK supports `kind: "memory"` plugins. If `memory-core` is disabled (via config or by not loading it), a custom plugin can register `memory_search` and `memory_get` as replacement tools with the same interface. The agent's system prompt references these tool names — as long as the plugin provides them, the agent works identically.

2. **Can we eliminate MEMORY.md injection?** — **Partially.** OpenClaw injects workspace files listed in config (`workspace.files`) into the system prompt. MEMORY.md is injected this way. We can remove it from the config. However, AGENTS.md, SOUL.md, etc. are separate — those stay as files. Only memory-specific .md files go away.

3. **What search infrastructure?** — `memory-core`'s builtin indexer uses OpenAI embeddings (text-embedding-3-small). HexMem already has its own embedding pipeline (`embed.py` + sqlite-vec). The plugin can use HexMem's existing vector search directly — no need to reindex.

4. **Lifecycle hooks available?** — **Yes.** `before_agent_start` can inject HexMem context (pending tasks, identity, recent events). `agent_end` can auto-capture session summaries. This replaces the manual `hexmem_pending_tasks` / `hexmem_recent_events` calls at session start.

### Architecture

```
┌──────────────────────────────────────────────────┐
│                  OpenClaw Agent                    │
│                                                    │
│  memory_search("routing optimization")            │
│       │                                            │
│       ▼                                            │
│  ┌──────────────────────────────────────┐         │
│  │  memory-hexmem plugin (kind:memory)  │         │
│  │                                      │         │
│  │  memory_search → HexMem semantic     │         │
│  │    search across ALL tables:         │         │
│  │    events, lessons, facts, tasks,    │         │
│  │    interactions, seeds, identity     │         │
│  │                                      │         │
│  │  memory_get → structured retrieval   │         │
│  │    by path-like reference:           │         │
│  │    "facts/routing" "lessons/fees"    │         │
│  │    "tasks/pending" "events/recent"   │         │
│  │                                      │         │
│  │  before_agent_start hook:            │         │
│  │    → inject identity summary         │         │
│  │    → inject pending tasks            │         │
│  │    → inject recent context (last 3)  │         │
│  │                                      │         │
│  │  agent_end hook:                     │         │
│  │    → auto-capture session summary    │         │
│  │    → log significant interactions    │         │
│  └──────────────┬───────────────────────┘         │
│                  │                                  │
└──────────────────┼──────────────────────────────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  hexmem.db       │
          │  (SQLite + vec)  │
          │                  │
          │  events          │
          │  lessons         │
          │  facts           │
          │  tasks           │
          │  interactions    │
          │  seeds           │
          │  identity        │
          │  embeddings      │
          └─────────────────┘
```

### What Changes

| Before | After |
|--------|-------|
| MEMORY.md (hand-curated) | Removed — facts/lessons in HexMem |
| memory/YYYY-MM-DD.md (daily logs) | Removed — events table in HexMem |
| memory/hexmem-*.md (sync files) | Not needed — direct queries |
| memory_search → scans .md files | memory_search → HexMem semantic search |
| memory_get → reads .md file lines | memory_get → structured HexMem retrieval |
| Manual hexmem_* bash calls at session start | Auto-injected via before_agent_start hook |
| Manual "remember this" → edit .md file | Auto-captured via agent_end hook + explicit hexmem_* tools |
| Two embedding pipelines | One (HexMem's sqlite-vec) |

### What Stays

- AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md — these are identity/config files, not memory
- HexMem bash helpers (hexmem.sh) — still available for explicit queries
- HexMem's full structured API (SQL queries, entity relationships, decay tiers)

### Implementation Plan

#### Step 1: Build the plugin (~4h)

```
~/clawd/extensions/memory-hexmem/
├── openclaw.plugin.json      # manifest: kind: "memory", id: "memory-hexmem"
├── index.ts                  # plugin entry point
├── search.ts                 # semantic search over HexMem
└── hooks.ts                  # before_agent_start / agent_end handlers
```

**memory_search implementation:**
```typescript
// Hybrid search: sqlite-vec embeddings + FTS5 text match
async function memorySearch(query: string, maxResults = 10, minScore = 0.5) {
  // 1. Get embedding for query (reuse HexMem's embed.py)
  // 2. Vector search across all embedded content in HexMem
  // 3. Also run FTS5 text search for exact matches
  // 4. Merge, deduplicate, rank by score
  // 5. Return results in memory_search format:
  //    { path: "hexmem://lessons/42", lines: "...", score: 0.87 }
}
```

**memory_get implementation:**
```typescript
// Path-based retrieval using hexmem:// URIs
async function memoryGet(path: string, from?: number, lines?: number) {
  // "hexmem://lessons/42" → fetch lesson by ID
  // "hexmem://facts/routing" → fetch facts about routing
  // "hexmem://tasks/pending" → fetch pending tasks
  // "hexmem://events/recent/5" → fetch 5 most recent events
  // Returns formatted text matching memory_get output format
}
```

#### Step 2: Migrate MEMORY.md into HexMem (~2h)

- Parse existing MEMORY.md entries into facts, lessons, and events
- Verify nothing is lost via before/after comparison
- Remove MEMORY.md from workspace.files config

#### Step 3: Migrate daily notes into HexMem (~1h)

- Parse memory/YYYY-MM-DD.md files into events
- Archive old .md files (don't delete — keep as historical record)
- Stop creating new daily .md files

#### Step 4: Update AGENTS.md session-start instructions (~30m)

- Remove "read MEMORY.md" and "read memory/YYYY-MM-DD.md" instructions
- Remove hexmem_pending_tasks / hexmem_recent_events calls (now auto-injected)
- Update memory writing instructions: "use hexmem_event, hexmem_lesson, hexmem_fact instead of editing .md files"

#### Step 5: Disable memory-core (~5m)

- Config change to disable the default memory-core plugin
- Verify memory_search/memory_get still work via the new plugin

### Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Plugin SDK changes in OpenClaw update | Plugin breaks | Pin OpenClaw version; plugin is small, easy to fix |
| HexMem's sqlite-vec search quality < OpenClaw's OpenAI embeddings | Worse recall | Can use OpenAI embeddings in the plugin instead of local model |
| Losing narrative context (stories in MEMORY.md that don't fit structured tables) | Identity continuity | Seeds table handles compressed narrative; facts handle discrete knowledge |
| Plugin fails to load | No memory at all | Fallback: re-enable memory-core; keep .md files archived (not deleted) |
| agent_end auto-capture is noisy | DB bloat | Filter: only capture sessions with >3 turns; add decay/cleanup |

### Estimated Effort

| Step | Effort | Dependency |
|------|--------|------------|
| Build plugin | 4h | OpenClaw plugin SDK docs |
| Migrate MEMORY.md | 2h | Plugin working |
| Migrate daily notes | 1h | Plugin working |
| Update AGENTS.md | 30m | After migration |
| Disable memory-core | 5m | After validation |
| **Total** | **~8h** | |

### Why This Over Option F

Option F (hybrid) preserves .md files as an intermediate layer — HexMem → .md → memory_search. That's two hops, sync lag, and .md files are still the source of truth for OpenClaw. 

Option G makes HexMem the **direct** source of truth. No sync scripts, no stale .md files, no dual maintenance. The plugin queries HexMem live on every `memory_search` call. Writes go straight to HexMem. One system, one source of truth.

The tradeoff is implementation effort (8h vs 2h for Phase 1 of F) and the risk of plugin SDK changes. But the maintenance savings compound — every session start is cleaner, every memory write goes to one place, and there's no sync to break.

---

## ~~3a. Previous Recommendation: Option F (Hybrid)~~

*Superseded by Option G above. Kept for reference.*



**Phase 1 (now, ~2 hours):** Build `hexmem-sync.sh`
- Exports hot facts, active lessons, pending tasks, recent events, identity summary to `memory/hexmem-*.md`
- Run via cron every 30 min or on heartbeat
- OpenClaw's `memory_search` immediately covers HexMem content

**Phase 2 (next week, ~4 hours):** Migrate MEMORY.md content into HexMem
- Parse existing MEMORY.md entries into facts/lessons/entities
- Generate MEMORY.md from HexMem (reversing the authorship)
- Reduce session-start token burn by relying on `memory_search` instead of loading full MEMORY.md

**Phase 3 (later, ~8 hours):** OpenClaw plugin
- Build `memory-hexmem` plugin for deeper integration
- Auto-inject identity and pending tasks via `before_agent_start` hook
- Auto-capture significant events via `agent_end` hook
- Replace the sync script with direct queries

### Rationale
- Phase 1 gives immediate value with zero risk
- Phase 2 eliminates the duplication problem
- Phase 3 is optional polish — only worth doing if the sync approach proves insufficient
- Each phase is independently useful; can stop at any point

---

## 4. Implementation Sketch

### Phase 1: `hexmem-sync.sh`

```bash
#!/bin/bash
# ~/clawd/hexmem/scripts/sync-to-memory.sh
source ~/clawd/hexmem/hexmem.sh

MEMORY_DIR="$HOME/clawd/memory"
mkdir -p "$MEMORY_DIR"

# Export pending tasks
echo "# HexMem Tasks (auto-generated)" > "$MEMORY_DIR/hexmem-tasks.md"
echo "Generated: $(date -Iseconds)" >> "$MEMORY_DIR/hexmem-tasks.md"
echo "" >> "$MEMORY_DIR/hexmem-tasks.md"
sqlite3 -markdown "$HEXMEM_DB" "SELECT id, title, priority, due_at FROM v_pending_tasks;" >> "$MEMORY_DIR/hexmem-tasks.md"

# Export hot facts
echo "# HexMem Active Facts (auto-generated)" > "$MEMORY_DIR/hexmem-facts.md"
sqlite3 -markdown "$HEXMEM_DB" \
  "SELECT COALESCE(e.name, f.subject_text) as subject, f.predicate, f.object_text 
   FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id 
   WHERE f.status='active' ORDER BY f.last_accessed_at DESC LIMIT 50;" >> "$MEMORY_DIR/hexmem-facts.md"

# Export active lessons  
echo "# HexMem Lessons (auto-generated)" > "$MEMORY_DIR/hexmem-lessons.md"
sqlite3 -markdown "$HEXMEM_DB" \
  "SELECT domain, lesson, confidence FROM lessons 
   WHERE status='active' ORDER BY confidence DESC LIMIT 30;" >> "$MEMORY_DIR/hexmem-lessons.md"

# Export recent events (last 3 days)
echo "# HexMem Recent Events (auto-generated)" > "$MEMORY_DIR/hexmem-recent.md"
sqlite3 -markdown "$HEXMEM_DB" \
  "SELECT occurred_at, event_type, category, summary FROM events 
   WHERE occurred_at > datetime('now', '-3 days') 
   ORDER BY occurred_at DESC LIMIT 30;" >> "$MEMORY_DIR/hexmem-recent.md"
```

**Add to crontab:** `*/30 * * * * ~/clawd/hexmem/scripts/sync-to-memory.sh`

### Phase 3: Plugin skeleton (future)

Location: `~/clawd/extensions/memory-hexmem/`
- `index.ts` — plugin using OpenClaw SDK
- `openclaw.plugin.json` — manifest with `kind: "memory"`
- Shells out to `hexmem_search` or `python3 search.py` for semantic search
- Uses `before_agent_start` hook to inject context

---

## 5. Tradeoffs Summary

| Approach | Effort | Risk | Value | Loses |
|----------|--------|------|-------|-------|
| **B: Sync script** | 2h | None | High — immediate coverage | Real-time freshness; write-back |
| **C: Plugin** | 8h | Medium — SDK changes | Highest — full integration | Maintenance burden |
| **D: Replace** | Variable | High | Unclear | Capabilities of dropped system |
| **E: MCP** | 6h | Medium | Good for multi-agent | Complexity; latency |
| **F: Hybrid (recommended)** | 2h now, more later | Low | Best long-term | Nothing — additive |

### What we gain with Option F:
- Single source of truth (HexMem) for structured knowledge
- `memory_search` covers everything without extra queries
- Reduced session-start token overhead
- Path to eliminating manual MEMORY.md maintenance

### What we preserve:
- HexMem's full structured query capability (SQL, entities, decay tiers, etc.)
- OpenClaw's lifecycle hooks and auto-recall
- Backward compatibility — nothing breaks if sync fails
