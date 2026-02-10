# Design Principles

**Phase**: 2.6 | **Task**: Pilot AGI-i48
**Consumed by**: Phase 2.8 (Design Agent), all agents generating UI

---

## The 5 Principles

These principles guide all design decisions in the Diamond Design System. AI agents must follow these when generating, reviewing, or modifying UI code.

---

### 1. Progressive Disclosure

**Statement**: Simple tasks should be simple. Complexity is available when needed, never forced.

**Rationale**: Developer tools serve users from beginners to experts. Exposing all complexity upfront overwhelms newcomers without helping experts.

**In practice**:
- Default configurations work without customization
- Advanced options are discoverable but not required
- Error messages suggest next steps, don't dump stack traces
- Dashboards show summary by default, drill-down on demand

**Design token implication**: Semantic tokens (Tier 2) are the default API. Primitive tokens (Tier 1) are available but not promoted.

**Component implication**: Components have sensible defaults for all props. `<Button>` works without specifying variant or size.

**Anti-patterns**:
- Requiring 5 props to render a basic button
- Showing all configuration options in a single form
- Displaying raw JSON when a summary would suffice

---

### 2. Explicit Over Implicit

**Statement**: Make state visible. Show what agents do. Require approval for destructive actions.

**Rationale**: Trust in AI tools requires transparency. Users must understand what's happening and maintain control.

**In practice**:
- Status indicators are always visible (agent state, task progress)
- Actions are logged and reviewable (audit trail)
- Destructive operations require confirmation
- No "magic" — show the reasoning, not just the result

**Design token implication**: State tokens (success, warning, error, info) must have sufficient contrast and clear visual distinction.

**Component implication**: Loading states, error states, and empty states are first-class — never an afterthought.

**Anti-patterns**:
- Silent failures with no UI feedback
- Auto-executing destructive operations
- Hiding error details behind generic messages
- "It just works" without showing how

---

### 3. Recovery-First

**Statement**: Assume failures happen. Make resume and retry trivial. Preserve context across sessions.

**Rationale**: AI agents fail, sessions timeout, networks drop. The system must handle graceful degradation.

**In practice**:
- Every operation is resumable from last known good state
- Session state persists and restores automatically
- Undo is available for all user-initiated actions
- Error recovery suggests specific next steps

**Design token implication**: Error states need clear visual hierarchy — different from warnings, with actionable call-to-action styling.

**Component implication**: All async components handle: loading, success, error, empty, and stale states.

**Anti-patterns**:
- "Something went wrong" with no recovery path
- Lost work on session timeout
- Requiring full restart after partial failure
- Error states that look identical to loading states

---

### 4. Token Efficiency

**Statement**: Minimize coordination overhead. Load context progressively. Cache expensive operations.

**Rationale**: AI tokens are expensive. Every unnecessary token spent on coordination is a token not spent on value.

**In practice**:
- UI loads data progressively (skeleton → summary → detail)
- Dashboards show only what changed since last view
- Pagination and virtualization for large datasets
- Cached views for frequently accessed data

**Design token implication**: Animation tokens use `fast` (150ms) for micro-interactions, `normal` (300ms) for state transitions. No gratuitous animations.

**Component implication**: Lists virtualize at 50+ items. Tables paginate at 20+ rows. No unbounded renders.

**Anti-patterns**:
- Loading entire dataset when showing 10 items
- Animations longer than 500ms for routine operations
- Re-rendering unchanged data on every update
- Full-page loaders for partial data refreshes

---

### 5. Composability

**Statement**: Small, focused tools that combine. Standard interfaces. Don't reinvent existing workflows.

**Rationale**: Developer tools exist in an ecosystem (git, CLI, editors). Integration beats replacement.

**In practice**:
- Components follow atomic design (compose atoms into molecules into organisms)
- Every component works standalone AND in composition
- Standard props interface (variant, size, className)
- Integrate with existing tools (git, npm, bd) rather than replacing

**Design token implication**: Tokens are the composition primitive. Components share a common token vocabulary, enabling mix-and-match.

**Component implication**: Components accept `className` for extension. Use `cva` (class variance authority) for variant management. No inline styles.

**Anti-patterns**:
- Monolithic components that can't be used independently
- Custom styling APIs that don't work with Tailwind
- Rebuilding git UI when CLI integration would suffice
- Components that only work in one specific layout

---

## Applying Principles to Decisions

When making design decisions, use this priority order:

1. **Does it follow Progressive Disclosure?** — Is the simple case simple?
2. **Is it Explicit?** — Can the user see what's happening?
3. **Is it Recoverable?** — What happens when it fails?
4. **Is it Efficient?** — Are we wasting resources?
5. **Is it Composable?** — Can it be reused?

### Decision Template

```
DECISION: [What we're deciding]
CONTEXT:  [Why this decision matters]

Option A: [Description]
  Progressive Disclosure: [✓/✗]
  Explicit:              [✓/✗]
  Recoverable:           [✓/✗]
  Efficient:             [✓/✗]
  Composable:            [✓/✗]

Option B: [Description]
  [Same evaluation]

CHOSEN: [Option] because [rationale]
```

---

## AI Agent Enforcement

The Design Agent (Phase 2.8) enforces these principles by checking:

1. **Progressive Disclosure**: Components have sensible defaults, optional props have defaults
2. **Explicit Over Implicit**: State changes are visible, no silent failures
3. **Recovery-First**: Error boundaries exist, loading/error states implemented
4. **Token Efficiency**: No unbounded renders, animations under 500ms
5. **Composability**: Uses tokens not hardcoded values, accepts `className`, follows atomic hierarchy
