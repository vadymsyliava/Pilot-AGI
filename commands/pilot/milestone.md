---
name: pilot:milestone
description: Manage project milestones. Create new milestones, complete current ones, or list all milestones. Use for major project checkpoints.
argument-hint: [new|complete|list]
allowed-tools: Read, Write, Glob
---

# Manage Milestones

You are managing project milestones.

## Arguments
- `$ARGUMENTS` can be:
  - `new` - Create a new milestone
  - `complete` - Complete current milestone
  - `list` - List all milestones
  - (empty) - Show current milestone status

## Action: new

Create a new milestone:

1. Ask about the milestone:
   - Name/version (e.g., "v1.0" or "MVP")
   - Key objectives
   - Target completion criteria

2. Update `.planning/ROADMAP.md`:
```markdown
## Milestone {N}: {Name}

### Objectives
- [ ] {Objective 1}
- [ ] {Objective 2}

### Phases
(To be planned)

### Success Criteria
- {Criterion 1}
- {Criterion 2}
```

3. Update STATE.md with new milestone.

## Action: complete

Complete the current milestone:

1. Verify all phases complete:
```
Milestone Completion Check
────────────────────────────────────────────────────────────────
  [✓] Phase 1: {name}
  [✓] Phase 2: {name}
  [✗] Phase 3: {name} - Not complete
```

2. If not all complete, warn:
```
⚠ Not all phases are complete.

Incomplete phases:
- Phase 3: {name}

Options:
1. Mark milestone complete anyway
2. Cancel and finish remaining phases
```

3. If confirmed complete:
   - Update ROADMAP.md with completion date
   - Archive milestone in STATE.md
   - Suggest creating git tag

```bash
git tag -a v{version} -m "Milestone: {name}"
```

4. Report:
```
════════════════════════════════════════════════════════════════
✓ Milestone Complete: {Name}
════════════════════════════════════════════════════════════════

Completed: {date}
Phases: {X} completed
Duration: {Y} days

Git tag created: v{version}

Ready to start the next milestone with /pilot:milestone new
```

## Action: list

List all milestones:

```
Project Milestones
════════════════════════════════════════════════════════════════

[✓] Milestone 1: Initial Setup
    Completed: 2026-01-15
    Phases: 3/3

[→] Milestone 2: Core Features  (current)
    Started: 2026-01-16
    Phases: 2/5

[ ] Milestone 3: Polish & Launch
    Planned

────────────────────────────────────────────────────────────────
Overall: 1/3 milestones complete
```

## Action: (default - status)

Show current milestone status:

```
Current Milestone: {Name}
════════════════════════════════════════════════════════════════

Progress: {X}% complete
Phases:
  [✓] Phase 1: {name}
  [→] Phase 2: {name} (in progress)
  [ ] Phase 3: {name}
  [ ] Phase 4: {name}

Next action: /pilot:plan 2
```

## Important Rules
- Milestones should represent significant achievements
- Don't create too many milestones - keep it manageable
- Always verify completion before marking done
- Use semantic versioning for milestone names when appropriate
