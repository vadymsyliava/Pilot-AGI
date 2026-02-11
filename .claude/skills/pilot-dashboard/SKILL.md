---
name: pilot-dashboard
description: Visibility dashboard showing agent status, tasks, drift alerts, worktree status, and health monitoring. Terminal-based overview of the multi-agent system.
argument-hint: [agents | drift | alerts | tasks | worktrees | events]
allowed-tools: Bash, Read, Glob
---

# Visibility Dashboard

You are displaying a real-time overview of the multi-agent Pilot AGI system.

## Quick Reference

```
/pilot-dashboard              → Full dashboard overview
/pilot-dashboard agents       → Agent health detail
/pilot-dashboard drift        → Drift detection for all agents
/pilot-dashboard alerts       → Active alerts only
/pilot-dashboard tasks        → Task breakdown by status
/pilot-dashboard worktrees    → Worktree status detail
/pilot-dashboard events       → Recent event stream
```

## Step 1: Collect Dashboard Data

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const data = dashboard.collect();
const alerts = dashboard.getAlerts();
console.log(JSON.stringify({ data, alerts }, null, 2));
" 2>/dev/null
```

## Step 2: Parse Arguments

Check `$ARGUMENTS` for subcommand:
- No args → Step 3 (Full Dashboard)
- "agents" → Step 4 (Agent Detail)
- "drift" → Step 5 (Drift Report)
- "alerts" → Step 6 (Alerts Only)
- "tasks" → Step 7 (Task Breakdown)
- "worktrees" → Step 8 (Worktree Detail)
- "events" → Step 9 (Event Stream)

---

## Step 3: Full Dashboard

Display the unified overview:

```
╔══════════════════════════════════════════════════════════════╗
║  PILOT AGI DASHBOARD                                         ║
╚══════════════════════════════════════════════════════════════╝

AGENTS ({active_count})
────────────────────────────────────────────────────────────────
  {status_icon} {session_id}  Task: {task_id}  Lease: {remaining}s
  {status_icon} {session_id}  Task: {task_id}  Lease: {remaining}s
  ...

  {If no agents: "No active agents"}

TASKS
────────────────────────────────────────────────────────────────
  In Progress: {count}    Open: {count}
  Closed:      {count}    Total: {count}

  [████████████░░░░░░░░] {percent}% complete

ALERTS ({alert_count})
────────────────────────────────────────────────────────────────
  {severity_icon} {alert message}
  {severity_icon} {alert message}
  ...

  {If no alerts: "All clear — no alerts"}

LOCKS
────────────────────────────────────────────────────────────────
  Areas: {list or "none"}
  Files: {list or "none"}

WORKTREES ({count})
────────────────────────────────────────────────────────────────
  {branch}  {path}  {locked_status}
  ...

  {If no worktrees: "No active worktrees"}

MESSAGING
────────────────────────────────────────────────────────────────
  Bus: {message_count} messages ({bus_size} bytes)
  Cursors: {cursor_count}  Compaction: {needed ? "NEEDED" : "OK"}

MEMORY CHANNELS
────────────────────────────────────────────────────────────────
  {channel_name}: {summary}
  ...

  {If no channels: "No active channels"}

RECENT EVENTS (last 5)
────────────────────────────────────────────────────────────────
  {timestamp} {type} {session_id} {details}
  ...

────────────────────────────────────────────────────────────────
```

Status icons:
- `●` healthy
- `◐` stale
- `○` unresponsive
- `⊘` lease_expired

Alert severity icons:
- `!!!` critical (drift detected, agent unresponsive)
- `!!` warning (stale agent, lease expiring, high pressure)
- `!` info (bus compaction, channel updates)

---

## Step 4: Agent Detail

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const data = dashboard.collect();
console.log(JSON.stringify(data.agents, null, 2));
" 2>/dev/null
```

Display detailed view per agent:

```
╔══════════════════════════════════════════════════════════════╗
║  AGENT STATUS                                                ║
╚══════════════════════════════════════════════════════════════╝

  {session_id}
  ├── Health:    {status} (heartbeat: {age}s ago)
  ├── Task:      {task_id}
  ├── Lease:     {remaining}s remaining
  ├── Worktree:  {path}
  ├── Locked:    {areas}
  └── Pressure:  {calls} calls, {pct}% context used

  ...
────────────────────────────────────────────────────────────────
```

---

## Step 5: Drift Report

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const data = dashboard.collect();
console.log(JSON.stringify(data.drift, null, 2));
" 2>/dev/null
```

Display drift detection results:

```
╔══════════════════════════════════════════════════════════════╗
║  DRIFT REPORT                                                ║
╚══════════════════════════════════════════════════════════════╝

  {session_id} — Task: {task_id}
  ├── Score:     {score} ({drifted ? "DRIFTED" : "OK"})
  ├── Threshold: {threshold}
  ├── Planned:   {planned_count} files
  ├── Actual:    {actual_count} files
  └── Unplanned: {unplanned list or "none"}

  ...

  {If no agents with tasks: "No agents with active tasks to check"}
────────────────────────────────────────────────────────────────
```

---

## Step 6: Alerts Only

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const alerts = dashboard.getAlerts();
console.log(JSON.stringify(alerts, null, 2));
" 2>/dev/null
```

Display:

```
╔══════════════════════════════════════════════════════════════╗
║  ACTIVE ALERTS                                               ║
╚══════════════════════════════════════════════════════════════╝

  {severity_icon} [{severity}] {message}
    └── {details}

  ...

  {If empty: "All clear — no active alerts"}
────────────────────────────────────────────────────────────────
```

---

## Step 7: Task Breakdown

```bash
bd list --json 2>/dev/null
```

Display tasks grouped by status with progress bar.

---

## Step 8: Worktree Detail

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const data = dashboard.collect();
console.log(JSON.stringify(data.worktrees, null, 2));
" 2>/dev/null
```

Display worktree paths, branches, lock status, and disk usage.

---

## Step 9: Event Stream

```bash
node -e "
const dashboard = require('./.claude/pilot/hooks/lib/dashboard');
const data = dashboard.collect();
console.log(JSON.stringify(data.events, null, 2));
" 2>/dev/null
```

Display last 20 events from sessions.jsonl in reverse chronological order.

---

## Important Rules

1. **Read-only** — the dashboard never modifies state
2. **Graceful degradation** — if any data source fails, show what's available
3. **No secrets** — never display file contents, only paths and metadata
4. **Performance** — collect once, display from cached data object
