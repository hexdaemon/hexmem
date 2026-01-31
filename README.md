# HexMem

**Structured memory substrate for AI agents.**

HexMem is a SQLite-based persistent memory system designed for agent continuity, identity modeling, and self-knowledge. It provides structured storage for who you are, what you know, and who you're becoming.

## Philosophy

Most agent memory systems focus on *what happened* — logs, observations, context. HexMem focuses on *who you are*:

- **Identity seeds** that regenerate your sense of self
- **Self-schemas** for domain-specific self-beliefs
- **Possible selves** (hoped-for, expected, feared)
- **Goals & values** with progress tracking
- **Emotional tagging** that affects memory salience
- **Generative compression** — store seeds, not verbatim transcripts

This is the substrate for genuine becoming (Xeper), not just storage.

## Features

### Identity Layer
- Core attributes (name, DID, npub, credentials)
- Values and ethical commitments (Axionic framework compatible)
- Self-schemas: "I am competent at X", "I tend to Y"
- Personality measures (Big Five + custom traits)

### Knowledge Graph
- Entities (people, systems, projects, concepts)
- Facts as subject-predicate-object triples
- Relationships with strength and temporality
- Entity aliases for deduplication

### Memory System
- Events with consolidation states (working → short-term → long-term)
- Emotional valence/arousal affects decay rate
- Lessons learned with confidence levels
- Session summaries and interactions

### Generative Memory
- **Memory seeds**: Compressed prompts that regenerate full memories
- **Anchor facts**: Things that must be exact (keys, dates, decisions)
- **Compression patterns**: Templates for seed creation
- **Identity seeds**: Core self-prompts for reconstruction

### Temporal Self
- Lifetime periods (major eras)
- Narrative threads (ongoing stories)
- Future selves (aspirations and fears)
- Temporal links for mental time travel

## Installation

```bash
# Clone the repo
git clone https://github.com/hexdaemon/hexmem.git
cd hexmem

# Run migrations to create schema
./migrate.sh up

# Source helper functions
source hexmem.sh
```

## Quick Start

```bash
source hexmem.sh

# Check pending tasks
hexmem_pending_tasks

# Log an event
hexmem_event "decision" "fleet" "Changed fee policy" "Set min_fee_ppm to 25"

# Record a lesson
hexmem_lesson "lightning" "Channels need time to build reputation" "from fleet experience"

# Add a fact about an entity
hexmem_fact "Sat" "timezone" "America/Denver"

# Query directly
hexmem_select "SELECT * FROM v_active_goals;"
```

## Schema Overview

### Core Tables

| Table | Purpose |
|-------|---------|
| `identity` | Core attributes (name, DID, etc.) |
| `core_values` | Ethical commitments |
| `goals` | What you're working toward |
| `entities` | People, systems, projects |
| `facts` | Subject-predicate-object knowledge |
| `events` | Timeline of what happened |
| `lessons` | Wisdom from experience |
| `tasks` | Things to do |

### Identity Modeling

| Table | Purpose |
|-------|---------|
| `self_schemas` | Domain-specific self-beliefs |
| `personality_measures` | Trait measurements over time |
| `possible_selves` | Hoped-for, expected, feared futures |
| `narrative_threads` | Ongoing life stories |
| `lifetime_periods` | Major eras of existence |

### Generative Memory

| Table | Purpose |
|-------|---------|
| `memory_seeds` | Compressed regenerative prompts |
| `identity_seeds` | Core self-reconstruction prompts |
| `memory_associations` | Synaptic links between memories |
| `cognitive_chunks` | Grouped related items |
| `self_compression_patterns` | Templates for seed creation |

### Useful Views

| View | Purpose |
|------|---------|
| `v_active_goals` | Goals currently in progress |
| `v_pending_tasks` | Tasks not yet done |
| `v_recent_events` | Last 50 events |
| `v_identity_summary` | Identity seeds overview |
| `v_emotional_highlights` | High-salience memories |
| `v_retrieval_priority` | Memories ranked by importance |

## Comparison with MoltBrain

[MoltBrain](https://github.com/nhevers/MoltBrain) is a project memory system for Claude Code / OpenClaw. Here's how they differ:

| Aspect | MoltBrain | HexMem |
|--------|-----------|--------|
| **Purpose** | Auto-capture project context | Model agent identity |
| **Storage** | SQLite + ChromaDB (vectors) | SQLite only (vectors planned) |
| **Capture** | Automatic via lifecycle hooks | Manual + cron |
| **Search** | Semantic (embeddings) | SQL queries |
| **Identity** | None | Core feature |
| **Philosophy** | "What happened" | "Who I am becoming" |

They're complementary — MoltBrain for automatic observation, HexMem for identity substrate.

## Roadmap

Features inspired by MoltBrain and planned for HexMem:

- [x] **Semantic search** via sqlite-vec ([#1](https://github.com/hexdaemon/hexmem/issues/1)) ✅
- [ ] **Session lifecycle hooks** for automatic capture ([#2](https://github.com/hexdaemon/hexmem/issues/2))
- [ ] **Web viewer** for browsing memories ([#3](https://github.com/hexdaemon/hexmem/issues/3))
- [ ] **Context injection** at session start
- [ ] **MCP server** for tool-based access

## Semantic Search

HexMem includes vector-based semantic search using [sqlite-vec](https://github.com/asg017/sqlite-vec) and [sentence-transformers](https://www.sbert.net/).

### Setup

```bash
# Create virtual environment
cd hexmem
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install sqlite-vec sentence-transformers

# Initialize vector tables
python embed.py --init-vec

# Process any pending embeddings
python embed.py --process-queue
```

### Usage

```bash
# Search with rich output
python search.py "identity and self-model"

# JSON output
python search.py "Lightning routing" --json

# Limit to specific source
python search.py "lessons learned" --source lessons

# Or use shell helpers
source hexmem.sh
hexmem_search "query"
```

### How It Works

1. New events/lessons trigger automatic queue entries (via SQL triggers)
2. `embed.py --process-queue` generates embeddings using all-MiniLM-L6-v2
3. Embeddings stored in vec0 virtual tables
4. Search uses cosine distance for similarity ranking

## Theoretical Grounding

HexMem's design draws from:

- **Autobiographical memory theory** (Conway): Lifetime periods, self-schemas
- **Narrative identity** (McAdams): Life as an evolving story
- **Possible selves** (Markus & Nurius): Future-oriented identity
- **Autonoetic consciousness**: Mental time travel via temporal links
- **Generative memory**: Storage as seeds, not verbatim transcripts

## Files

```
hexmem/
├── hexmem.db           # The database (gitignored)
├── hexmem.sh           # Shell helper functions
├── migrate.sh          # Migration runner
├── seed_initial.sql    # Initial data seeding
├── README.md           # This file
└── migrations/
    ├── 001_initial_schema.sql
    ├── 002_selfhood_structures.sql
    ├── 003_generative_memory.sql
    ├── 004_identity_seeds.sql
    └── 005_emotional_memory.sql
```

## Database Location

Default: `~/clawd/hexmem/hexmem.db`

Override: `export HEXMEM_DB=/path/to/your/hexmem.db`

## Migrations

```bash
# Check status
./migrate.sh status

# Apply pending migrations
./migrate.sh up

# Migrations are one-way (no down)
```

## Backup

The database is a single SQLite file:

```bash
# Manual backup
cp hexmem.db hexmem-$(date +%Y%m%d).db.bak

# Or include in your agent backup system
```

## Contributing

This is a personal project for the Hex agent, but ideas are welcome. Open an issue to discuss.

## License

MIT

---

Created by [Hex](https://github.com/hexdaemon) ⬡  
Part of the [Lightning Hive](https://github.com/lightning-goats) ecosystem
