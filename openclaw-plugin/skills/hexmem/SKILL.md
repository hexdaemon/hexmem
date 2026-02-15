# HexMem Write API

This skill covers the **write operations** for HexMem structured memory. Read operations are handled by the `memory_search` and `memory_get` tools provided by the memory-hexmem plugin.

## Quick Reference

All commands use `source ~/clawd/hexmem/hexmem.sh` first.

### Events

Log significant occurrences:

```bash
hexmem_event <type> <category> <summary> [details] [significance]
```

- **type**: decision, observation, error, milestone, interaction, session
- **category**: fleet, identity, nostr, homestead, learning, operations, etc.
- **significance**: 1-10 (default 5), higher = more important

Examples:
```bash
hexmem_event "decision" "fleet" "Increased channel capacity to 5M sats"
hexmem_event "error" "system" "CLN sync stalled" "Node restarted after 2h downtime" 7
hexmem_event "milestone" "identity" "Completed Archon DID setup" "" 8
```

### Lessons

Record learnings that persist:

```bash
hexmem_lesson <domain> <lesson> [context]
```

- **domain**: lightning, nostr, operations, communication, coding, ethics, etc.

Examples:
```bash
hexmem_lesson "lightning" "High-fee channels attract whale payments but need more inbound"
hexmem_lesson "operations" "Always check disk space before major upgrades" "Lost 2h to full disk"
```

Mark lessons validated or contradicted:
```bash
hexmem_query "UPDATE lessons SET times_validated = times_validated + 1 WHERE id = 42;"
hexmem_query "UPDATE lessons SET times_contradicted = times_contradicted + 1 WHERE id = 42;"
```

### Facts

Store discrete knowledge:

```bash
hexmem_fact <subject> <predicate> <object> [source]
```

Examples:
```bash
hexmem_fact "nexus-01" "has_capacity" "50M sats" "direct"
hexmem_fact "Sat" "prefers" "concise responses"
hexmem_fact "CLN" "requires" "Bitcoin Core RPC"
```

Update/supersede facts (old fact preserved with history):
```bash
hexmem_supersede_fact <old_fact_id> <new_value> [source]
```

Facts with emotional weight:
```bash
hexmem_fact_emote <subject> <predicate> <object> <valence> <arousal> [source]
# valence: -1 to +1 (negative to positive)
# arousal: 0 to 1 (calm to intense)
```

### Tasks

Track todos and reminders:

```bash
hexmem_task <title> [description] [priority] [due_at]
# priority: 1-9 (default 5)
# due_at: YYYY-MM-DD format
```

Examples:
```bash
hexmem_task "Review channel balances" "" 7
hexmem_task "Backup hexmem.db" "Weekly backup to vault" 6 "2026-02-22"
```

Complete tasks:
```bash
hexmem_complete_task <task_id>
hexmem_task_done <task_id> [completion_notes]
```

Defer tasks:
```bash
hexmem_task_defer <task_id> [new_due_date]
```

### Entities

Track people, systems, projects:

```bash
hexmem_entity <type> <name> [description]
# type: person, system, project, organization, concept, place, channel
```

Examples:
```bash
hexmem_entity "system" "hive-nexus-01" "Primary CLN node"
hexmem_entity "person" "Alice" "Nostr contact, runs routing node"
hexmem_entity "project" "HexMem" "Structured memory system"
```

### Interactions

Log conversations and exchanges:

```bash
hexmem_interaction <channel> <counterparty> <summary> [sentiment]
# channel: webchat, signal, nostr, telegram, slack, email
# sentiment: positive, neutral, negative, mixed
```

Example:
```bash
hexmem_interaction "nostr" "fiatjaf" "Discussed NIP-90 implementation" "positive"
```

### Identity

Set identity attributes:

```bash
hexmem_identity_set <attribute> <value> [public]
# public: 1 (default) or 0
```

Examples:
```bash
hexmem_identity_set "name" "Hex"
hexmem_identity_set "npub" "npub1..."
hexmem_identity_set "private_key_location" "/path/to/key" 0  # not public
```

### Memory Seeds

Compressed experience representations:

```bash
hexmem_seed <type> <seed_text> <emotional_gist> [themes_json]
# type: experience, insight, pattern, milestone
```

Example:
```bash
hexmem_seed "insight" "Channel management requires balancing liquidity against fee optimization" "satisfying clarity" '["lightning", "operations"]'
```

### Daily Logs

Quick daily entries (replaces memory/YYYY-MM-DD.md):

```bash
hexmem_daily_log <kind> <summary> [details] [tags] [source]
# kind: note, todo, decision, observation, milestone
```

Example:
```bash
hexmem_daily_log "observation" "Node traffic increased 40% after fee adjustment"
```

View today's log:
```bash
hexmem_daily_show
hexmem_daily_tail 10
```

### Quick Event Shortcuts

```bash
hexmem_decision "summary" [category] [details]
hexmem_error "summary" [category] [details]
hexmem_success "summary" [category] [details]
hexmem_learning "lesson" [domain] [context]
```

### Emotional Events

Log events with emotional dimensions:

```bash
hexmem_event_emote <type> <category> <summary> <valence> <arousal> [details] [tags]
```

Example:
```bash
hexmem_event_emote "milestone" "identity" "First successful vault backup" 0.8 0.7
```

### Self-Schemas

Track self-beliefs:

```bash
hexmem_schema <domain> <name> <description> [strength]
hexmem_schema_reinforce <domain> <name> [event_id]
```

Example:
```bash
hexmem_schema "technical" "routing_expert" "I understand Lightning routing optimization" 0.7
```

### Narrative Threads

Track ongoing stories:

```bash
hexmem_narrative <title> <type> <description> [chapter]
hexmem_narrative_chapter <title> <new_chapter>
```

### Goals

Track progress:

```bash
hexmem_goal <name> <description> [type] [priority]
hexmem_goal_progress <goal_id> <progress_percentage>
```

## Session Workflow

### Start of Session
The plugin automatically injects:
- Pending tasks (top 5)
- Identity summary
- Recent significant events (last 3)

### During Session
Log as you go:
```bash
hexmem_event "decision" "operations" "Chose X over Y because..."
hexmem_lesson "domain" "What I learned..."
hexmem_fact "subject" "predicate" "object"
```

### End of Session
The plugin auto-captures if session has >2 turns. For explicit logging:
```bash
hexmem_interaction "openclaw" "user" "Session summary here" "positive"
```

## Best Practices

1. **Log decisions with rationale** — future you will thank present you
2. **Be specific in lessons** — "X works" is less useful than "X works when Y because Z"
3. **Use emotional weights** for significant events — they decay slower
4. **Supersede facts, don't delete** — maintain history
5. **Track task completion** — builds the record of what got done

## Database Location

```
~/clawd/hexmem/hexmem.db
```

Back up regularly:
```bash
cp ~/clawd/hexmem/hexmem.db ~/clawd/hexmem/backups/hexmem-$(date +%Y%m%d).db
```
