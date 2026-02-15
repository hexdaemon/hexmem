# memory-hexmem

OpenClaw memory plugin backed by HexMem SQLite database. Replaces the built-in `memory-core` plugin with structured memory queries across events, lessons, facts, tasks, interactions, and seeds.

## Features

- **memory_search** — Semantic search across all HexMem tables
- **memory_get** — Structured retrieval by `hexmem://` URI paths
- **Context injection** — Auto-injects pending tasks, identity, and recent events at session start
- **Auto-capture** — Logs interaction events for sessions with >2 turns
- **Bundled skill** — Teaches the agent the HexMem write API

## Installation

1. Ensure HexMem is set up at `~/clawd/hexmem/hexmem.db`

2. Add the plugin to OpenClaw config (`~/.openclaw/config.json5`):

```json5
{
  plugins: {
    // Set memory slot to use this plugin instead of memory-core
    slots: {
      memory: "memory-hexmem"
    },

    // Register the plugin location
    entries: {
      "memory-hexmem": {
        path: "~/clawd/extensions/memory-hexmem"
      }
    }
  }
}
```

3. Optional: Configure the plugin:

```json5
{
  plugins: {
    entries: {
      "memory-hexmem": {
        path: "~/clawd/extensions/memory-hexmem",
        config: {
          // Custom DB path (default: ~/clawd/hexmem/hexmem.db)
          dbPath: "~/clawd/hexmem/hexmem.db",

          // Context injection at session start
          contextInjection: {
            enabled: true,
            maxTasks: 5,      // Pending tasks to inject
            maxEvents: 3,     // Recent events to inject
            includeIdentity: true
          },

          // Auto-capture sessions as interactions
          autoCapture: {
            enabled: true,
            minTurns: 2       // Minimum user turns to trigger
          }
        }
      }
    }
  }
}
```

## Usage

### memory_search

Search across all HexMem tables:

```
memory_search("routing optimization")
```

Returns results like:
```
- hexmem://lessons/42 (95%): [lightning] High-fee channels attract whale payments
- hexmem://events/156 (88%): [decision/fleet] Adjusted routing fees
- hexmem://facts/23 (75%): nexus-01 has_capacity 50M sats
```

### memory_get

Retrieve specific items by path:

```
memory_get("hexmem://lessons/42")          # Specific lesson by ID
memory_get("hexmem://tasks/pending")       # All pending tasks
memory_get("hexmem://events/recent")       # Recent events
memory_get("hexmem://facts")               # All active facts
memory_get("hexmem://identity")            # Public identity attributes
```

### Writing to Memory

Use the bundled HexMem skill (automatically loaded) for write operations:

```bash
source ~/clawd/hexmem/hexmem.sh

hexmem_event "decision" "fleet" "Increased channel capacity"
hexmem_lesson "lightning" "Larger channels reduce rebalancing frequency"
hexmem_fact "nexus-01" "has_capacity" "100M sats"
hexmem_task "Review channel balances" "" 7
```

## Architecture

```
memory_search("query")
        │
        ▼
┌─────────────────────────────────┐
│   memory-hexmem plugin          │
│                                 │
│   SQLite LIKE search across:    │
│   - events (summary, details)   │
│   - lessons (lesson, context)   │
│   - facts (subject, predicate,  │
│           object)               │
│   - tasks (title, description)  │
│   - interactions (summary)      │
│   - seeds (seed_text, gist)     │
└──────────────┬──────────────────┘
               │
               ▼
        hexmem.db (SQLite)
```

## Context Injection

At session start, the plugin automatically injects:

```
<hexmem-context>
**Pending Tasks:**
- [9] Critical: Fix routing issue
- [7] Review channel balances
- [5] Update documentation

**Identity:** name: Hex, npub: npub1...

**Recent Events:**
- [2026-02-15 10:30] Completed vault backup
- [2026-02-15 09:15] Channel rebalance succeeded
</hexmem-context>
```

This replaces loading MEMORY.md at session start.

## Requirements

- OpenClaw with plugin support
- SQLite3 CLI (`sqlite3` in PATH)
- HexMem database at configured path
- Node.js with TypeScript (jiti loads the plugin)

## Files

```
~/clawd/extensions/memory-hexmem/
├── openclaw.plugin.json    # Plugin manifest
├── index.ts                # Main plugin (tools + hooks)
├── README.md               # This file
└── skills/hexmem/
    └── SKILL.md            # Write API documentation
```

## Differences from memory-core

| Feature | memory-core | memory-hexmem |
|---------|-------------|---------------|
| Storage | Markdown files | SQLite database |
| Search | Vector embeddings | SQLite LIKE (text) |
| Structure | Flat text | Tables: events, facts, lessons, etc. |
| Context injection | Loads MEMORY.md | Injects pending tasks + identity |
| Auto-capture | No | Yes (interactions table) |
| Write API | Edit .md files | Shell out to hexmem.sh |

## Troubleshooting

**Plugin not loading:**
- Check `plugins.slots.memory` is set to `"memory-hexmem"`
- Verify plugin path in `plugins.entries`
- Check OpenClaw logs for errors

**Search returns no results:**
- Verify HexMem DB exists: `ls ~/clawd/hexmem/hexmem.db`
- Test direct query: `sqlite3 ~/clawd/hexmem/hexmem.db "SELECT COUNT(*) FROM events;"`

**Context not injecting:**
- Check `contextInjection.enabled` is `true` (default)
- Verify tasks/events exist in HexMem

## License

MIT
