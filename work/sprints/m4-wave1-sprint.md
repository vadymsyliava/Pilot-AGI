# Sprint: M4 Wave 1 — Process Control Foundation

**Milestone**: 4 (Process Control & Immortal Agents)
**Sprint Goal**: Build the 3 independent foundation pieces: clean session lifecycle, pure Node.js PM daemon, and terminal management
**Start**: 2026-02-11
**Tasks**: 3 (all independent, can run in parallel with 3 agents)

---

## Tasks

| ID | Phase | Title | Size | Agent Role |
|----|-------|-------|------|------------|
| Pilot AGI-3j0 | 4.1 | Session Lifecycle Overhaul | M | infra |
| Pilot AGI-ock | 4.4 | PM Daemon as Pure Node.js | L | infra |
| Pilot AGI-031 | 4.5 | Terminal Management | M | infra |

---

## Task Details

### Phase 4.1 — Session Lifecycle Overhaul

**Why first**: Sessions have no clean death signal. Zombie sessions accumulate. PID-based liveness is partially there but not the primary check. This is the foundation everything else depends on.

**Subtasks** (4):
1. Process exit hook: detect spawned agent death via SIGTERM/SIGINT/exit, mark session ended
2. PID-primary liveness: make `kill -0 <pid>` the primary liveness check, heartbeat secondary
3. Zombie reaper upgrade: periodic sweep marks sessions as ended if PID is dead, cleans locks
4. Session archival: move old ended sessions (>24h) to `sessions/archive/`

**Key files**: `session.js`, `pm-daemon.js`
**Tests needed**: Exit hook fires on process death, zombie reaper cleans dead sessions, archival moves old files
**Estimated lines**: ~100 new/modified

---

### Phase 4.4 — PM Daemon as Pure Node.js

**Why parallel**: PM daemon already exists as Node.js but still relies on Claude session for complex decisions. This phase makes it fully standalone with AI-assisted judgment calls via one-shot `claude -p`.

**Subtasks** (5):
1. `pm-decisions.js` module: wrap complex decisions (merge review, decomposition) as one-shot `claude -p` calls
2. Decision routing: mechanical decisions (spawn, health, cleanup) stay pure Node.js; judgment decisions use `pm-decisions.js`
3. CLI expansion: `--status` (full state), `--ps` (process table), `--kill <taskId>`, `--tail <taskId>`
4. Replace `/pilot-pm` dependency: daemon CLI provides everything the Claude PM session did
5. Structured logging: all decisions logged to `pm-daemon.log` with decision type and rationale

**Key files**: `pm-daemon.js`, new `pm-decisions.js`
**Tests needed**: Decision routing (mechanical vs judgment), CLI commands output, status reporting
**Estimated lines**: ~500 new/modified

---

### Phase 4.5 — Terminal Management

**Why parallel**: Agents are invisible processes. No way to see output, tail logs, or manage processes. This is pure observability — no deps on other phases.

**Subtasks** (4):
1. `agent-logger.js` module: redirect spawned agent stdout/stderr to per-task log files
2. Log streaming: `--tail <taskId>` streams live agent output
3. Process table: `--ps` shows PID, task, duration, context %, status for all agents
4. Kill command: `--kill <taskId>` gracefully stops an agent (SIGTERM → wait → SIGKILL)

**Key files**: new `agent-logger.js`, `pm-daemon.js`
**Tests needed**: Log capture to file, process table accuracy, graceful kill
**Estimated lines**: ~300 new/modified

---

## Dependencies

```
All 3 tasks are independent (Wave 1).
No cross-dependencies within this sprint.

Wave 2 tasks (4.2, 4.6) will depend on 4.1 + 4.4 completing.
```

## Success Criteria

- [ ] Active sessions = actually running processes (no zombies after reaper runs)
- [ ] `kill -0 <pid>` used as primary liveness check
- [ ] PM daemon runs standalone with `--watch`, no Claude session needed
- [ ] Complex decisions (review, decompose) via short `claude -p` calls
- [ ] `--ps` shows real-time process table
- [ ] `--tail <taskId>` streams agent logs
- [ ] `--kill <taskId>` gracefully stops agents
