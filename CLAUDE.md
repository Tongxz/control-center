# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Start the server (also: node server.js)
```

No build step, no test runner, no linter configured. The server listens on **port 18799**.

## Architecture

**OpenClaw Control Center** is a local dashboard for monitoring and managing a multi-agent orchestration system (OpenClaw). It has three layers:

- **Backend**: `server.js` — Express REST API + JSON file persistence
- **Frontend**: `public/index.html` — Single-page app (vanilla JS, no framework)
- **Data**: `runtime/*.json` and `runtime/*.log` (JSONL) files

### Core Modules

| File | Responsibility |
|------|---------------|
| `server.js` | Express server, all REST routes, JSON persistence helpers, timeline recording |
| `poll.js` | Polls the `openclaw` CLI every 30s, builds `runtime/last-snapshot.json` |
| `indexer.js` | Bridges `~/.openclaw/workspace/` — reads/writes workspace docs and per-agent memory files |

### Data Persistence

All state lives in `runtime/`:
- `tasks.json`, `projects.json`, `approvals.json` — mutable JSON arrays
- `timeline.log`, `approval-actions.log` — append-only JSONL audit logs
- `last-snapshot.json` — cached snapshot from `poll.js` (overwritten every 30s)
- `budget-config.json` — token budget settings

Schemas for tasks, projects, and snapshots are in `shared/schemas/`.

### Key Design Patterns

- **Audit trail**: Every state mutation calls `recordTimeline({agent, type, targetId, summary, before, after})`, which appends to `timeline.log`. Always include this when modifying state.
- **Before/after snapshots**: `PATCH` handlers capture the object state before and after changes for the timeline entry.
- **CLI integration**: `poll.js` spawns `openclaw` subprocesses; stdout is JSON but may contain noise, so `parseJson()` strips non-JSON lines before parsing.
- **No database**: Reads the entire JSON file, modifies in memory, writes back atomically. Fine for current scale.

### Agent System

The four recognized agent IDs are: `main`, `forge`, `reviewer`, `sentinel`. All task/project/approval operations track `ownerAgentId` or `agent` field for attribution.

### External Dependency

The `openclaw` CLI must be installed and in PATH. `poll.js` uses it for `status --json`, `agents list --json`, `cron list --json`, and `sessions --json`. Workspace docs and memory are stored at `~/.openclaw/workspace/`.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
