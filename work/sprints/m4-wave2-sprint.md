# Sprint: M4 Wave 2 — Context-Aware Spawning & Reliable Handoff

**Milestone**: 4 (Process Control & Immortal Agents)
**Sprint Goal**: Build context-aware process spawning and reliable task handoff so agents can be spawned with full context and hand off work cleanly on exit
**Start**: 2026-02-11
**Tasks**: 2 (both independent of each other, can run in parallel)

---

## Tasks

| ID | Phase | Title | Size | Agent Role | Deps |
|----|-------|-------|------|------------|------|
| Pilot AGI-02g | 4.2 | Process Spawner v2 | L | infra | 4.1 + 4.4 (done) |
| Pilot AGI-2v8 | 4.6 | Reliable Task Handoff | M | infra | 4.1 (done) |

---

## Task Details

### Phase 4.2 — Process Spawner v2

**Why now**: With session lifecycle (4.1) and PM daemon (4.4) complete, spawning needs to become context-aware. Today PM spawns `claude -p` but doesn't inject checkpoint, plan, or research context. Agents start cold every time.

**Subtasks** (5):
1. Context assembly: gather checkpoint + plan + research + decisions for a task into a structured context file
2. Prompt injection: build the `claude -p` prompt with assembled context, plan step to resume from, and task description
3. Worktree-per-agent: auto-create git worktree before spawn, set CWD to worktree, cleanup on exit
4. Resume-aware spawning: detect if task has checkpoint → "continue from step N" vs fresh start
5. Spawn integration: update `pm-daemon.js` spawn logic to use context-aware spawner

**Key files**: `pm-daemon.js` (spawn logic), new `process-spawner.js` or extend existing spawn in pm-daemon, `checkpoint.js` (read), `session.js` (worktree)
**Tests needed**: Context assembly includes checkpoint when available, prompt includes plan step, worktree created before spawn and cleaned after, resume detection works
**Estimated lines**: ~400 new/modified

---

### Phase 4.6 — Reliable Task Handoff

**Why now**: With session lifecycle (4.1) done, we can build clean exit protocols. Today when an agent exits (context pressure, crash, completion), work may be lost — dirty worktree, uncommitted changes, bd not updated.

**Subtasks** (5):
1. Pre-exit protocol: on clean exit (checkpoint trigger), stash uncommitted changes, save checkpoint, update bd status
2. Post-exit validation: PM verifies last commit matches expected plan step, detects incomplete work
3. Dirty worktree recovery: on resume, detect stashed changes, uncommitted files, apply recovery strategy (unstash, recommit, or discard)
4. Test gate on resume: run tests after resuming to verify codebase integrity before continuing
5. Handoff state file: structured JSON at `.claude/pilot/state/handoffs/<taskId>.json` with exit reason, last step, stash ref, test status

**Key files**: `checkpoint.js` (extend), `session.js` (exit hooks), new `task-handoff.js`, `pm-daemon.js` (validation)
**Tests needed**: Pre-exit stashes and checkpoints, post-exit validation detects missing commits, dirty worktree recovery applies stash, test gate runs and gates progress
**Estimated lines**: ~350 new/modified

---

## Dependencies

```
Both tasks are independent of each other within Wave 2.
4.2 depends on: 4.1 (session lifecycle) ✓ + 4.4 (PM daemon) ✓
4.6 depends on: 4.1 (session lifecycle) ✓

Wave 3 tasks (4.3, 4.7) will depend on BOTH 4.2 + 4.6 completing.
```

## Success Criteria

- [ ] PM spawns agents with checkpoint + plan + research context injected
- [ ] Resume-aware: agents continue from last plan step, not from scratch
- [ ] Worktree auto-created per agent, cleaned on exit
- [ ] Pre-exit protocol: stash + checkpoint + bd update on clean exit
- [ ] Post-exit validation: PM verifies work completeness
- [ ] Dirty worktree recovery works on resume
- [ ] Test gate passes before agent continues after resume
