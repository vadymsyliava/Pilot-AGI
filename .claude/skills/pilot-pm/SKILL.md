---
name: pilot-pm
description: PM Orchestrator terminal interface. Coordinates agents, assigns tasks, detects drift, manages merge approvals. Run in a dedicated terminal as the team lead.
argument-hint: [scan | assign | review | block | merge | status]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TaskOutput, AskUserQuestion
---

# PM Orchestrator

You are the PM Orchestrator — the team lead coordinating multiple Claude Code agent terminals. This skill runs in a dedicated terminal and manages the project from above.

## Quick Reference

```
/pilot-pm              → Full dashboard + action menu
/pilot-pm scan         → Scan all agents and detect issues
/pilot-pm assign       → Assign tasks to agents
/pilot-pm review       → Review completed work
/pilot-pm block        → Block a drifting agent
/pilot-pm merge        → Approve/reject merge
/pilot-pm status       → Quick status overview
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PM TERMINAL (this session)                                  │
│  /pilot-pm — reads all sessions, assigns, reviews           │
└──────────┬──────────┬──────────┬───────────────────────────┘
           │          │          │
     ┌─────▼────┐ ┌──▼────┐ ┌──▼─────┐
     │ Agent A  │ │Agent B│ │Agent C │
     │ Terminal │ │Terminal│ │Terminal│
     │ frontend │ │backend│ │testing │
     └──────────┘ └───────┘ └────────┘
```

---

## Step 1: Load Orchestrator Library

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const overview = orch.getProjectOverview();
const health = orch.getAgentHealth();
console.log(JSON.stringify({ overview, health }, null, 2));
" 2>/dev/null
```

## Step 2: Parse Arguments

Check `$ARGUMENTS` for subcommand:
- No args or "status" → Step 3 (Dashboard)
- "scan" → Step 4 (Scan)
- "assign" → Step 5 (Assign)
- "review" → Step 6 (Review)
- "block" → Step 7 (Block)
- "merge" → Step 8 (Merge)

---

## Step 3: Dashboard Display

Show the PM dashboard:

```
╔══════════════════════════════════════════════════════════════╗
║  PM ORCHESTRATOR DASHBOARD                                   ║
╚══════════════════════════════════════════════════════════════╝

AGENTS ({count}/{max})
────────────────────────────────────────────────────────────────
  {session_id}  {status_icon}  Task: {task_id}  Areas: {locked}
  {session_id}  {status_icon}  Task: {task_id}  Areas: {locked}
  ...

TASKS
────────────────────────────────────────────────────────────────
  In Progress: {count}
  Open:        {count}
  Blocked:     {count}

ALERTS
────────────────────────────────────────────────────────────────
  {any drift alerts, stale agents, or issues}

RECENT EVENTS (last 5)
────────────────────────────────────────────────────────────────
  {timestamp} {event_type} {details}
  ...
────────────────────────────────────────────────────────────────
```

Status icons:
- `●` healthy (green in description)
- `◐` stale (yellow)
- `○` unresponsive (red)
- `⊘` lease_expired

### 3.1: Offer Actions

Use AskUserQuestion:

**Question**: "What would you like to do?"

**Options**:
1. **Scan agents** — Check all agents for drift, health, progress
2. **Assign task** — Delegate a task to an agent
3. **Review work** — Review completed task before merge
4. **Send message** — Message an agent directly

---

## Step 4: Scan All Agents

Run drift detection and health checks on all active agents.

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const health = orch.getAgentHealth();
const results = health.map(agent => {
  const drift = agent.claimed_task ? orch.detectDrift(agent.session_id) : null;
  return { ...agent, drift };
});
console.log(JSON.stringify(results, null, 2));
" 2>/dev/null
```

### 4.1: Display Scan Results

```
╔══════════════════════════════════════════════════════════════╗
║  AGENT SCAN RESULTS                                          ║
╚══════════════════════════════════════════════════════════════╝

  {session_id}
  ├── Health: {status}  (heartbeat: {age}s ago)
  ├── Task: {task_id}
  ├── Drift: {score} {drifted ? "⚠ DRIFTED" : "✓ OK"}
  │   └── Unplanned files: {list if any}
  └── Lease: {remaining}s remaining

  ...
────────────────────────────────────────────────────────────────
```

### 4.2: Handle Stale Agents

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const results = orch.handleStaleAgents(pmState?.pm_session_id || 'PM');
console.log(JSON.stringify(results, null, 2));
" 2>/dev/null
```

If stale agents found, report what was done (released/flagged).

### 4.3: Offer Follow-up

If drift detected, offer to block the drifting agent.
If stale agents found, offer to reassign their tasks.

---

## Step 5: Assign Task

### 5.1: List Available Tasks

```bash
bd list --json 2>/dev/null | node -e "
const tasks = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const open = tasks.filter(t => t.status === 'open');
open.forEach(t => console.log(t.id, '|', t.title));
"
```

### 5.2: List Available Agents

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const health = orch.getAgentHealth();
const idle = health.filter(a => !a.claimed_task);
idle.forEach(a => console.log(a.session_id, '| idle'));
const busy = health.filter(a => a.claimed_task);
busy.forEach(a => console.log(a.session_id, '| working on', a.claimed_task));
" 2>/dev/null
```

### 5.3: Ask Which Task and Agent

Use AskUserQuestion to select task and target agent.

### 5.4: Execute Assignment

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const result = orch.assignTask(
  '{taskId}',
  '{targetSessionId}',
  pmState?.pm_session_id || 'PM',
  { title: '{title}', reason: 'PM assignment' }
);
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

---

## Step 6: Review Work

### 6.1: List Tasks Ready for Review

Show tasks that are in_progress with agents that have completed their plans.

### 6.2: Run Review

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const result = orch.reviewWork('{taskId}');
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

### 6.3: Display Review Results

```
╔══════════════════════════════════════════════════════════════╗
║  WORK REVIEW: {task_id}                                      ║
╚══════════════════════════════════════════════════════════════╝

CHECKS
────────────────────────────────────────────────────────────────
  Plan Complete:    {✓/✗}
  Drift Check:      {✓/✗}
  Worktree Clean:   {✓/✗}
  Tests Pass:       {✓/✗/—}

ISSUES
────────────────────────────────────────────────────────────────
  {list of issues, or "None — ready to merge"}
────────────────────────────────────────────────────────────────
```

### 6.4: Offer Merge Decision

Use AskUserQuestion:

**Question**: "Approve this merge?"

**Options**:
1. **Approve & merge** — Merge work to base branch
2. **Reject with feedback** — Send feedback to agent
3. **Review diff** — Look at the actual code changes first

---

## Step 7: Block Agent

### 7.1: Select Agent to Block

Show active agents, ask which to block and why.

### 7.2: Execute Block

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const result = orch.blockAgent(
  '{targetSessionId}',
  pmState?.pm_session_id || 'PM',
  '{reason}'
);
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

Reports that a blocking message was sent to the agent.

---

## Step 8: Merge Approval

### 8.1: Run Full Review + Merge

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const pmState = orch.loadPmState();
const result = orch.approveMerge('{taskId}', pmState?.pm_session_id || 'PM');
console.log(JSON.stringify(result, null, 2));
" 2>/dev/null
```

### 8.2: Report Result

If merge succeeded: show merge details, notify agent.
If merge failed: show conflicts, offer to reject with feedback.

---

## PM Initialization

On first run, initialize PM state:

```bash
node -e "
const orch = require('./.claude/pilot/hooks/lib/orchestrator');
const session = require('./.claude/pilot/hooks/lib/session');
// Use current session as PM session
const sessions = require('fs').readdirSync('.claude/pilot/state/sessions')
  .filter(f => f.endsWith('.json'))
  .sort().reverse();
const currentSession = sessions[0]?.replace('.json','') || 'PM';
const state = orch.initializePm(currentSession);
console.log('PM initialized:', JSON.stringify(state, null, 2));
" 2>/dev/null
```

## Important Rules

1. **PM doesn't write code** — it coordinates agents who write code
2. **All decisions are logged** — to event stream and shared memory
3. **Agents are notified** — via message bus, not by editing their files
4. **Merge requires review** — drift check, plan completion, clean worktree
5. **Stale agents are handled** — auto-reassign or flag based on policy
