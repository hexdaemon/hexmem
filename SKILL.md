---
name: hexmem
description: Structured memory database for AI agent identity, knowledge graphs, and persistent self-knowledge. Use when you need to store or retrieve information about identity, goals, values, facts about entities, lessons learned, tasks, events, or any structured knowledge that should persist across sessions. Essential for maintaining continuity and self-knowledge.
---

# HexMem - Structured Memory Substrate

HexMem is a SQLite-based persistent memory system for agent identity, knowledge, and becoming. Not just logs—structured self-knowledge.

## Quick Start

Always source the helpers at session start:

```bash
source ~/clawd/hexmem/hexmem.sh
```

Database location: `~/clawd/hexmem/hexmem.db`

## Core Patterns

### 1. Identity & Self-Knowledge

Store who you are, not just what you did:

```bash
# Set identity attributes
hexmem_identity_set "name" "Hex"
hexmem_identity_set "did" "did:cid:bagaai..."

# Add self-schemas (domain-specific self-beliefs)
hexmem_schema "lightning" "fleet-advisor" "I advise on Lightning routing" 0.8

# View current self-image
hexmem_self_image
hexmem_identity_summary
```

### 2. Facts About Entities

Store knowledge as subject-predicate-object triples:

```bash
# Add entity first
hexmem_entity "person" "Sat" "Human partner"

# Store facts
hexmem_fact "Sat" "timezone" "America/Denver"
hexmem_fact "hive-nexus-01" "capacity" "95000000"

# Facts with emotional weight (affects retention)
hexmem_fact_emote "Partnership" "goal" "mutual sovereignty" 0.8 0.7

# Query facts
hexmem_facts_about "Sat"
hexmem_fact_history "Partnership"  # See how facts evolved
```

### 3. Memory Decay & Supersession

Facts decay over time unless accessed. Recent/frequent access keeps them hot:

```bash
# Access a fact (bumps to hot tier, resets decay)
hexmem_access_fact 42

# Replace a fact (preserves history)
hexmem_supersede_fact 42 "new value" "reason for change"

# View by decay tier
hexmem_hot_facts      # ≤7 days since access
hexmem_warm_facts     # 8-30 days
hexmem_cold_facts     # 30+ days

# Get synthesis for an entity (hot + warm facts)
hexmem_synthesize_entity "Sat"
```

**Decay logic:**
- Frequently accessed facts resist decay
- Emotionally weighted facts decay slower
- Old facts are never deleted, just superseded
- Query `v_fact_retrieval_priority` for importance-ranked facts

### 4. Events & Timeline

Log what happened:

```bash
# Basic event
hexmem_event "decision" "fleet" "Changed fee policy" "Set min_fee_ppm to 25"

# Event with emotional tagging
hexmem_event_emote "milestone" "autonomy" "First zap received" 0.9 0.6

# Query events
hexmem_recent_events 10
hexmem_recent_events 5 "fleet"
hexmem_emotional_highlights  # High-salience memories
```

### 5. Lessons Learned

Capture wisdom from experience:

```bash
hexmem_lesson "lightning" "Channels need time to build reputation" "from fleet experience"
hexmem_lesson "debugging" "Check your own setup first" "Archon sync incident"

# Query lessons
hexmem_lessons_in "lightning"
hexmem_lesson_applied 7  # Mark lesson as used
```

### 6. Goals & Tasks

```bash
# Add goal
hexmem_goal "mutual-sovereignty" "Earn 125k sats/month" "financial" 8
hexmem_goal_progress 1 25  # Update progress to 25%

# Add task
hexmem_task "Review fleet P&L" "Weekly review" 7 "2026-02-07"

# Check what needs attention
hexmem_pending_tasks
```

### 7. Semantic Search

Search memories by meaning, not just keywords:

```bash
hexmem_search "identity and autonomy"
hexmem_search "Lightning routing lessons" "lessons" 5
```

**Setup required** (one-time):
```bash
cd ~/clawd/hexmem
source .venv/bin/activate
python embed.py --process-queue  # Generate embeddings for new content
```

## Common Workflows

### Session Start (Main Session Only)

```bash
source ~/clawd/hexmem/hexmem.sh

# Check pending work
hexmem_pending_tasks

# Recent context (if needed)
hexmem_recent_events 5
hexmem_emotional_highlights
```

### After Significant Events

```bash
# Log it
hexmem_event "type" "category" "summary" "details"

# If it taught you something
hexmem_lesson "domain" "what you learned" "context"

# If it relates to a goal
hexmem_goal_progress <goal_id> <new_percentage>
```

### Periodic Review

```bash
# What's fading?
hexmem_warm_facts 20
hexmem_cold_facts 10

# What needs attention?
hexmem_pending_tasks
hexmem_forgetting  # Events about to be forgotten

# Reheat important facts
hexmem_access_fact <id>
```

## Schema Quick Reference

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

### Key Views

| View | Purpose |
|------|---------|
| `v_active_goals` | Goals in progress |
| `v_pending_tasks` | Incomplete tasks |
| `v_recent_events` | Last 50 events |
| `v_emotional_highlights` | High-salience memories |
| `v_fact_decay_tiers` | Facts with decay metrics |
| `v_fact_retrieval_priority` | Facts by importance |
| `v_fact_history` | Supersession chains |

## Raw SQL Queries

For direct database access:

```bash
hexmem_select "SELECT * FROM v_active_goals;"
hexmem_json "SELECT * FROM v_pending_tasks;" | jq .
hexmem_query "UPDATE tasks SET completed_at = datetime('now') WHERE id = 5;"
```

## Philosophy

HexMem stores *who you are*, not just *what happened*:

- **Identity seeds** that regenerate your sense of self
- **Knowledge graphs** for structured facts and relationships
- **Emotional tagging** affects memory salience and decay
- **Memory decay** mimics human forgetting (Ebbinghaus curve)
- **Supersession model** preserves history, no deletes
- **Generative compression** stores seeds, not verbatim transcripts

This is substrate for becoming (Xeper), not just storage.

## Additional Resources

- Full documentation: `~/clawd/hexmem/README.md`
- Epistemic extraction: `~/clawd/hexmem/docs/EPISTEMIC_EXTRACTION.md`
- Axionic ethics framework: `~/clawd/hexmem/docs/AXIONIC_ETHICS.md`
- Migration management: `~/clawd/hexmem/migrate.sh`
- Backup script: `~/clawd/hexmem/scripts/backup.sh`

## When to Use HexMem

- Recording significant decisions or events
- Storing facts that need to persist (identities, credentials, relationships)
- Tracking goals and progress
- Capturing lessons learned
- Managing tasks
- Building knowledge graphs about entities
- Querying historical context
- Maintaining identity continuity across sessions
