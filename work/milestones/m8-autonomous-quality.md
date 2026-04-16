# Milestone 8: Autonomous Code Quality & Self-Healing

**Goal**: Make Pilot AGI a fully automated, self-healing, self-improving system that enforces canonical code quality across every project. No duplicate code, no legacy hacks, no inconsistent naming — one source of truth for everything.

**Target**: v7.0.0

## Core Principles

1. **Single Source of Truth** — Every page, component, API endpoint, and DB collection is registered. If it's not in the registry, it doesn't exist.
2. **Canonical Only** — One pattern per concept. No two functions doing the same thing. No backward-compat shims.
3. **Auto-Enforce** — Quality gates run on every edit, not just on commit. Prevention > detection > cleanup.
4. **Self-Healing** — When issues are detected, the system fixes them (with plan approval), not just flags them.
5. **Self-Improving** — Quality rules evolve based on what works. Agents learn what "good code" means for THIS project.

---

## Wave 1: Auto-Wire M7 Features (make existing work automatic)

### Phase 8.1: Soul Auto-Lifecycle
- Auto-restore soul from global backup on session start (if no local soul exists)
- Auto-backup soul to global directory on task close
- Auto-take snapshot before any soul mutation (for diff tracking)
- Wire into session-start hook and pilot-close skill
- AC: Soul survives session restarts without manual backup/restore

### Phase 8.2: Auto Self-Assessment
- Auto-record task completion metrics on every pilot-close
- Auto-sync skill scores to soul after each assessment update
- Auto-detect skill gaps and surface them in agent context on session start
- Wire into post-tool-use.js for commit detection and task close hooks
- AC: Agent metrics update automatically, no manual invocation needed

### Phase 8.3: Auto Peer Review Gate
- Block merge unless peer review is completed (configurable in policy.yaml)
- Auto-select reviewer based on soul expertise match
- Auto-execute lightweight review for small diffs (<50 lines)
- Full review required for large diffs — reviewer soul learns from outcome
- Wire into pilot-pm-review skill and PM merge approval flow
- AC: No merge happens without at least one peer review recorded

---

## Wave 2: Project Registry — Single Source of Truth

### Phase 8.4: Project Registry Core
- project-registry.js — central registry at .claude/pilot/registry/
- Four registry domains: pages.json, components.json, apis.json, database.json
- Each entry: { id, name, file_path, type, description, created_by, created_at, dependencies[] }
- CRUD API: registerPage(), registerComponent(), registerAPI(), registerCollection()
- Lookup API: findByName(), findByPath(), findByPattern(), listAll(domain)
- Duplicate detection: before register, check for name/path/pattern similarity
- AC: Registry exists, CRUD works, duplicates blocked

### Phase 8.5: Auto-Discovery & Registration
- Codebase scanner that builds initial registry from existing code
- Page discovery: scan router files (Next.js pages/, React Router, etc.)
- Component discovery: scan component directories, detect exports
- API discovery: scan route handlers, express/fastify/hono endpoints
- DB discovery: scan schema files (Prisma, Drizzle, Mongoose, raw SQL migrations)
- Framework detection: auto-detect project type and scan accordingly
- Incremental update: on file create/edit, auto-update registry
- AC: Running scanner on existing project produces accurate registry

### Phase 8.6: Registry Enforcement in Hooks
- Pre-tool-use hook checks registry before allowing new file creation
- "Are you creating a new page? Check registry first — does one already exist?"
- "Are you creating a new API endpoint? Check registry for duplicates"
- Agent context injection: registry summary loaded on session start
- PM dashboard: registry overview showing all pages/components/APIs/collections
- AC: Creating duplicate page/component/API is blocked with clear message

---

## Wave 3: Code Quality Enforcement

### Phase 8.7: Canonical Pattern Registry
- canonical-patterns.js — project-specific pattern definitions
- Pattern categories: naming conventions, file structure, import style, error handling, state management
- Auto-learn: after N consistent usages of a pattern, register it as canonical
- Pattern examples stored with source references
- Conflict detection: if two patterns serve same purpose, flag for resolution
- AC: Patterns registered, lookup works, conflicts detected

### Phase 8.8: Duplicate Code Detection
- Pre-edit scan: before writing a function, check for existing similar functions
- AST-level similarity (not just text): detect functions with same logic, different names
- Export dedup: flag re-exports, wrapper functions that just pass through
- Cross-file detection: find same logic implemented in multiple places
- Suggestion: "Function X in file A does the same thing — use that instead"
- AC: Duplicate function creation is caught and blocked with suggestion

### Phase 8.9: Dead Code & Legacy Detector
- Scan for unused exports (no imports anywhere in codebase)
- Detect backward-compat shims: renamed vars with underscore prefix, re-exports, removed comments
- Detect TODO/FIXME/HACK comments older than N days
- Flag deprecated patterns that have canonical replacements
- Integration with quality score (dead code reduces score)
- AC: Dead code detected, reported, score reflects it

---

## Wave 4: Self-Healing

### Phase 8.10: Auto-Refactor on Detection
- When duplicate detected: generate plan to consolidate into single canonical implementation
- When dead code found: generate plan to remove it safely
- When naming inconsistency found: generate plan to rename across codebase
- All auto-fixes go through plan approval (configurable: auto-approve for low-risk)
- Atomic commits: each fix is one commit with clear explanation
- AC: System proposes fixes, executes after approval, commits atomically

### Phase 8.11: Naming Consistency Enforcer
- One name per concept: if a DB collection is called "users", the API is "/users", the component is "UserList", not "MemberList"
- Cross-layer consistency: DB to API to Component to Page all use same terminology
- Name registry: map of concept to canonical name across all layers
- Auto-detect inconsistencies by cross-referencing registry domains
- AC: Naming inconsistency across layers is detected and flagged

### Phase 8.12: Post-Merge Quality Sweep
- After every merge, PM daemon runs full quality scan
- Check: new duplicates introduced? Dead code? Naming inconsistencies?
- Quality score before/after: if score decreased, flag the merge
- Auto-create follow-up tasks for quality issues found
- Trend tracking: quality score over time per agent and per project
- AC: Every merge triggers quality scan, issues become tasks

---

## Wave 5: Self-Improving Quality

### Phase 8.13: Quality Metrics to Soul Feedback
- Quality scores feed back into agent self-assessment
- Agents that produce cleaner code get higher skill scores
- Agents learn which patterns work best from quality outcomes
- Soul preferences auto-update: "I learned that pattern X leads to fewer duplicates"
- AC: Quality metrics visible in soul, affect future decisions

### Phase 8.14: Pattern Evolution
- When a new pattern proves superior (higher quality scores), propose migration
- Generate migration plan: find all old pattern usages, create refactor plan
- Gradual migration: don't break everything at once, migrate file-by-file
- Rollback: if migration causes regressions, revert and record lesson
- AC: Better patterns auto-propagate, old patterns auto-sunset

### Phase 8.15: Quality Regression Prevention
- Quality score floor: commits that drop score below threshold are blocked
- Per-area thresholds: stricter for core modules, relaxed for experimental
- Grace period: new features get temporary relaxation, tightened after stabilization
- Trend alerts: if quality trending down over N commits, escalate to human
- AC: Quality can only go up (or stay stable), never silently regress
