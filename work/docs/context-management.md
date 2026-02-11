# Context Window Management

## Overview

Pilot AGI agents autonomously manage their context window lifecycle:
checkpoint → compact → resume. No human intervention needed for normal operation.

## How It Works

### Auto-Checkpoint (60% pressure)

When an agent's estimated context usage hits 60%, the `post-tool-use` hook
automatically saves a checkpoint containing:

- Current task ID and title
- Plan progress (step N of M)
- Completed steps with results
- Key decisions made
- Files modified
- Important findings

Checkpoint data is stored at:
`.claude/pilot/memory/agents/<session-id>/checkpoint.json`

### Compact Limitation

**`/compact` is a Claude Code built-in command and cannot be triggered
programmatically.** There is no API, stdin injection, or hook mechanism to
force a compaction.

**Workaround**: When auto-checkpoint fires, the agent receives a system
message recommending `/compact`. The PM terminal also monitors agent pressure
and sends nudge messages at 70%.

In practice, compaction happens when:
1. The agent naturally runs `/compact` after seeing the nudge
2. Claude Code's own context management triggers it
3. The user manually runs `/compact` in the agent's terminal

### Auto-Resume (session start)

On session start, the `session-start` hook:

1. Checks for a checkpoint under the current session ID
2. Falls back to scanning the 5 most recent session files for checkpoints
3. If found, builds a restoration prompt with full task context
4. Injects the prompt as the first system message

The agent resumes work from the exact plan step where it left off.

### PM Pressure Monitoring

The PM orchestrator periodically scans all active sessions' `.pressure.json`
files. Agents above 70% receive a `pressure_warning` notification via the
message bus.

### PM Self-Checkpoint

The PM checkpoints its own orchestrator state (active assignments, queue
status, recent decisions, bus health) so it can recover after its own
compaction.

The PM loop calls `checkPmSelfPressure()` on each cycle, which:
1. Reads the PM session's `.pressure.json` file
2. If pressure >= 70%, saves a PM checkpoint via `savePmCheckpoint()`
3. Resets pressure counters after successful checkpoint
4. Returns `{ checkpointed: true/false, pct: number }`

## Pressure Thresholds

| Threshold | Action |
|-----------|--------|
| 60% | Auto-checkpoint fires (post-tool-use hook) |
| 70% | PM sends pressure nudge notification |
| 80%+ | Agent should compact immediately |

## File Locations

| File | Purpose |
|------|---------|
| `.claude/pilot/state/sessions/S-xxx.pressure.json` | Per-session pressure data |
| `.claude/pilot/memory/agents/S-xxx/checkpoint.json` | Checkpoint data |
| `.claude/pilot/memory/agents/S-xxx/history/` | Archived checkpoint versions |
| `.claude/pilot/hooks/lib/checkpoint.js` | Save/load/restore logic |
| `.claude/pilot/hooks/lib/pm-pressure-monitor.js` | PM monitoring + self-checkpoint |
| `.claude/pilot/hooks/lib/context-gatherer.js` | Programmatic context inference |
| `.claude/pilot/hooks/lib/pressure.js` | Pressure estimation |
