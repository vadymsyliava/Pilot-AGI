---
name: pilot-resume-context
description: Restore agent working context from a saved checkpoint. Use after context compaction or session restart.
allowed-tools: Read, Bash, Glob, Grep
---

# Resume Context from Checkpoint

You are restoring a previously saved working state after context compaction or session restart.

## Step 1: Find session and checkpoint

### 1.1: Get current session ID
```bash
SESSION_FILE=$(ls -t .claude/pilot/state/sessions/S-*.json 2>/dev/null | grep -v pressure | head -1)
if [ -n "$SESSION_FILE" ]; then
  node -e "const s=JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'));console.log(JSON.stringify({session_id:s.session_id,claimed_task:s.claimed_task}))"
fi
```

### 1.2: Load checkpoint
```bash
node -e "
  const cp = require('./.claude/pilot/hooks/lib/checkpoint');
  const checkpoint = cp.loadCheckpoint('{session_id}');
  if (checkpoint) {
    console.log(JSON.stringify(checkpoint, null, 2));
  } else {
    console.log('NO_CHECKPOINT');
  }
"
```

## Step 2: Handle no checkpoint

If no checkpoint exists:

```
╔══════════════════════════════════════════════════════════════╗
║  NO CHECKPOINT FOUND                                         ║
╚══════════════════════════════════════════════════════════════╝

No saved checkpoint for session {session_id}.

Possible actions:
1. Check session capsule (runs/YYYY-MM-DD.md) for last known state
2. Check bd for active task: bd list --status in_progress
3. Start fresh with /pilot-next
```

If using arguments (e.g., `/pilot-resume-context S-other-session`), try loading that session's checkpoint instead.

## Step 3: Display restored context

Generate the restoration prompt using the checkpoint library:

```bash
node -e "
  const cp = require('./.claude/pilot/hooks/lib/checkpoint');
  const checkpoint = cp.loadCheckpoint('{session_id}');
  if (checkpoint) {
    console.log(cp.buildRestorationPrompt(checkpoint));
  }
"
```

Display as:

```
╔══════════════════════════════════════════════════════════════╗
║  CONTEXT RESTORED                                            ║
╚══════════════════════════════════════════════════════════════╝

TASK
────────────────────────────────────────────────────────────────
  [{task_id}] {task_title}
  Progress: Step {N} of {total}
  Saved at: {timestamp}

COMPLETED STEPS
────────────────────────────────────────────────────────────────
  ✓ Step 1: {description}
  ✓ Step 2: {description}
  → Step 3: {next step — this is where you resume}

KEY DECISIONS
────────────────────────────────────────────────────────────────
  • {decision 1}
  • {decision 2}

FILES MODIFIED
────────────────────────────────────────────────────────────────
  • {file1}
  • {file2}

IMPORTANT FINDINGS
────────────────────────────────────────────────────────────────
  • {finding 1}
  • {finding 2}

CURRENT CONTEXT
────────────────────────────────────────────────────────────────
{free-form context string}
────────────────────────────────────────────────────────────────
```

## Step 4: Re-read key files

After displaying the checkpoint, automatically re-read the most important files that were modified:

1. Read the plan file if it exists
2. Read the last 2-3 modified files (from `files_modified`)
3. This gives the agent actual file content, not just names

## Step 5: Show checkpoint history

```bash
node -e "
  const cp = require('./.claude/pilot/hooks/lib/checkpoint');
  const history = cp.listCheckpointHistory('{session_id}');
  console.log(JSON.stringify(history, null, 2));
"
```

If history exists, show:
```
CHECKPOINT HISTORY
────────────────────────────────────────────────────────────────
  v1: Step 2 of 9 — saved 10:30
  v2: Step 5 of 9 — saved 11:15
  v3: Step 7 of 9 — saved 12:00 (current)
────────────────────────────────────────────────────────────────
```

## Step 6: Suggest next action

Based on the checkpoint, suggest:

```
NEXT ACTION
────────────────────────────────────────────────────────────────
Continue with Step {N}: {description}

Files to review:
  • {relevant files for next step}
────────────────────────────────────────────────────────────────
```

## Important Rules

1. Always display the full checkpoint — the agent lost all context
2. Re-read modified files to rebuild actual code awareness
3. If no checkpoint exists, fall back to session capsule
4. Show history so the agent can load an older checkpoint if needed
5. Suggest the concrete next action to minimize disorientation
