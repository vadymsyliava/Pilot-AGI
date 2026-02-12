---
name: pilot-checkpoint
description: Save current working state to checkpoint for context recovery. Use before /compact or when context pressure is high.
allowed-tools: Read, Bash, Glob, Grep
---

# Save Context Checkpoint

You are saving the agent's current working state so it can be recovered after context compaction.

## Step 1: Gather current context

### 1.1: Get session ID
```bash
SESSION_FILE=$(ls -t .claude/pilot/state/sessions/S-*.json 2>/dev/null | grep -v pressure | head -1)
if [ -n "$SESSION_FILE" ]; then
  node -e "const s=JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'));console.log(JSON.stringify({session_id:s.session_id,claimed_task:s.claimed_task}))"
fi
```

### 1.2: Get active task
```bash
bd list --status in_progress --json 2>/dev/null || echo "[]"
```

### 1.3: Get current pressure
```bash
node -e "
  const p = require('./.claude/pilot/hooks/lib/pressure');
  const sid = process.argv[1];
  const stats = p.getPressure(sid);
  console.log(JSON.stringify(stats));
" "{session_id}"
```

### 1.4: Get recently modified files
```bash
git diff --name-only HEAD~5 2>/dev/null || git diff --name-only 2>/dev/null || echo "none"
```

## Step 2: Collect working state

Ask the agent (yourself) to recall:
- What task are you working on?
- What plan step are you on?
- What steps have you completed?
- What key decisions have you made?
- What important things have you discovered?
- What is the current state of your work?

Combine this with the data from Step 1.

## Step 3: Save checkpoint

```bash
node -e "
  const cp = require('./.claude/pilot/hooks/lib/checkpoint');
  const result = cp.saveCheckpoint('{session_id}', {
    task_id: '{task_id}',
    task_title: '{task_title}',
    plan_step: {step_number},
    total_steps: {total_steps},
    completed_steps: {completed_steps_json},
    key_decisions: {key_decisions_json},
    files_modified: {files_json},
    current_context: '{context_summary}',
    important_findings: {findings_json},
    tool_call_count: {calls},
    output_bytes: {bytes}
  });
  console.log(JSON.stringify(result, null, 2));
"
```

Replace all `{placeholders}` with actual values from Steps 1-2.

## Step 4: Reset pressure counters

After saving, reset the pressure tracker so nudges restart from zero:

```bash
node -e "
  const p = require('./.claude/pilot/hooks/lib/pressure');
  p.resetPressure('{session_id}');
  console.log('Pressure counters reset');
"
```

## Step 5: Display confirmation

```
╔══════════════════════════════════════════════════════════════╗
║  CHECKPOINT SAVED                                            ║
╚══════════════════════════════════════════════════════════════╝

  Session:  {session_id}
  Task:     [{task_id}] {task_title}
  Progress: Step {N} of {total}
  Version:  {checkpoint_version}

SAVED CONTEXT
────────────────────────────────────────────────────────────────
  Steps done:  {count}
  Decisions:   {count}
  Files:       {count}
  Findings:    {count}
────────────────────────────────────────────────────────────────

Pressure counters reset. Safe to /compact now.
If context is compacted, run /pilot-resume-context to restore.
```

## Step 6: Update session capsule

```bash
echo "### Checkpoint Saved: $(date +%H:%M)
- Session: {session_id}
- Task: {task_id}
- Step: {N} of {total}
- Version: {checkpoint_version}" >> runs/$(date +%Y-%m-%d).md
```

## Important Rules

1. Capture as much context as possible — this is the agent's lifeline after compaction
2. Include file paths so the resumed agent knows what to re-read
3. Include key decisions so the agent doesn't re-debate choices
4. Reset pressure counters after save
5. This skill does NOT compact — it only saves state
