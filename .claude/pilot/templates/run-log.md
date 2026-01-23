# Run Log Template

Session capsules are daily logs stored in `runs/YYYY-MM-DD.md`. They provide:
- Crash recovery context
- Audit trail of work done
- Resume hints for next session

## File Naming

```
runs/
├── 2026-01-20.md
├── 2026-01-21.md
└── 2026-01-22.md
```

## Session Header

Each day starts with:

```markdown
## 2026-01-22 Session

Project: {project name or directory}
Started: {HH:MM}
```

## Task Entries

### Task Started

```markdown
### Task: {HH:MM}
- ID: {bd-xxxx}
- Title: {title}
- Status: in_progress
```

### Plan Created

```markdown
### Plan: {HH:MM}
- Task: {bd-xxxx}
- Steps: {N}
- Status: Approved
- Next: /pilot-exec
```

### Step Executed

```markdown
### Step {N}: {HH:MM}
- Task: {bd-xxxx}
- Step: {step name}
- Files: {files changed}
- Verified: {yes/no}
```

### Commit Made

```markdown
### Commit: {HH:MM}
- Hash: {short hash}
- Message: {commit message}
- Files: {N} changed
```

### Task Completed

```markdown
### Task closed: {HH:MM}
- Task: {bd-xxxx}
- Title: {title}
- Commits: {N}
- Duration: {time from claim to close}

### Summary
{Brief summary of what was accomplished}
```

## Resume Context

At the end of each session or before a break, add:

```markdown
---

### Session End: {HH:MM}

**Resume context:**
- Current task: {bd-xxxx or "none"}
- Last action: {what was just done}
- Next action: {what should happen next}
- Blockers: {any issues to address}

**Files in progress:**
- {file path} - {status: editing/reviewing/testing}

**Notes:**
{Any important context for the next session}
```

## Example Complete Session

```markdown
## 2026-01-22 Session

Project: pilot-agi
Started: 09:00

### Task: 09:05
- ID: bd-a1b2
- Title: Add user authentication
- Status: in_progress

### Plan: 09:15
- Task: bd-a1b2
- Steps: 4
- Status: Approved
- Next: /pilot-exec

### Step 1: 09:30
- Task: bd-a1b2
- Step: Create auth middleware
- Files: src/middleware/auth.ts
- Verified: yes

### Commit: 09:35
- Hash: abc1234
- Message: feat(auth): add JWT validation middleware [bd-a1b2]
- Files: 1 changed

### Step 2: 10:00
- Task: bd-a1b2
- Step: Add login endpoint
- Files: src/routes/auth.ts, src/services/auth.ts
- Verified: yes

### Commit: 10:10
- Hash: def5678
- Message: feat(auth): add login endpoint with password validation [bd-a1b2]
- Files: 2 changed

### Task closed: 10:30
- Task: bd-a1b2
- Title: Add user authentication
- Commits: 2
- Duration: 1h 25m

### Summary
Implemented JWT-based authentication with login endpoint. Middleware validates
tokens and adds user to request context. Password hashing uses bcrypt.

---

### Session End: 10:35

**Resume context:**
- Current task: none
- Last action: Closed authentication task
- Next action: Pick next task with /pilot-next
- Blockers: none

**Notes:**
Remember to add logout endpoint in follow-up task.
```

## Usage by Hooks

The session-start.js hook reads the most recent run log to find:
- `Next action:` line for resume hints
- `Resume:` line for context

Skills like pilot-commit, pilot-exec, and pilot-close update the run log
after each action.
