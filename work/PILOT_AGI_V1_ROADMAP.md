# Pilot AGI v1.0 Release Roadmap

> AI-Powered Development Framework for Solo Developers

---

## Executive Summary

Pilot AGI v1.0 transforms from a skill-based workflow into a comprehensive **AI-guided development orchestrator**. The key innovation: **one command to go from idea to production-ready code**.

```
npx pilot-agi init → Questions → Brief → Roadmap → Sprint → Implementation → Review → Ship
```

---

## Core Philosophy

### For Solo Developers, Not Corporate Teams

- **Zero bureaucratic overhead** - No Jira, no ceremonies, no estimates
- **AI handles the process** - Human focuses on decisions and code
- **Progressive disclosure** - Start simple, add complexity only when needed
- **Quality by default** - Tests, security, accessibility from day one

---

## v1.0 Feature Overview

### Phase 1: Intelligent Project Initialization

**Command:** `/pilot-init` or `npx pilot-agi init`

```
┌─────────────────────────────────────────────────────────────┐
│                    INITIALIZATION FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. PITCH (30 seconds)                                      │
│     User: "I want to build a habit tracker app"             │
│                                                             │
│  2. AI ANALYSIS (Automatic)                                 │
│     - Parse intent                                          │
│     - Identify project type (web, mobile, CLI)              │
│     - Suggest architecture                                  │
│                                                             │
│  3. SMART QUESTIONS (2-5 minutes)                           │
│     Adaptive questioning based on project type:             │
│     - Who are your users?                                   │
│     - What's the #1 thing it must do well?                  │
│     - Any design preferences? (dark mode, minimal, etc.)    │
│     - Tech preferences? (or "suggest best")                 │
│     - MVP scope or full product?                            │
│                                                             │
│  4. BRIEF GENERATION (Automatic)                            │
│     Creates: work/PROJECT_BRIEF.md                          │
│     - Problem statement                                     │
│     - Target users                                          │
│     - Core features (prioritized)                           │
│     - Tech stack decisions                                  │
│     - Success criteria                                      │
│                                                             │
│  5. USER APPROVAL                                           │
│     Review brief, modify if needed, approve to continue     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Question Framework

**Tier 1: Essential (Always Ask)**
| Question | Purpose |
|----------|---------|
| What does it do? (1 sentence) | Core value proposition |
| Who uses it? | Target user persona |
| What's the main action? | Primary user flow |
| MVP or full product? | Scope definition |

**Tier 2: Technical (Ask if relevant)**
| Question | Purpose |
|----------|---------|
| Where does data live? | Backend needs |
| Real-time features? | WebSocket/SSE requirements |
| Authentication needed? | Auth architecture |
| Existing design system? | UI foundation |

**Tier 3: Context (Ask for complex projects)**
| Question | Purpose |
|----------|---------|
| Reference apps? | Design inspiration |
| Integration requirements? | External APIs |
| Compliance needs? | Security/regulatory |
| Deployment target? | Infrastructure planning |

---

### Phase 2: Roadmap & Sprint Planning

**Command:** `/pilot-plan`

```
┌─────────────────────────────────────────────────────────────┐
│                    PLANNING FLOW                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. ROADMAP GENERATION                                      │
│     Creates: work/ROADMAP.md                                │
│                                                             │
│     Phase 1: Foundation (Week 1)                            │
│     ├── Project setup & tooling                             │
│     ├── Design system foundation                            │
│     └── Authentication (if needed)                          │
│                                                             │
│     Phase 2: Core MVP (Week 2-3)                            │
│     ├── Primary feature                                     │
│     ├── Secondary features                                  │
│     └── Data persistence                                    │
│                                                             │
│     Phase 3: Polish (Week 4)                                │
│     ├── Testing & bug fixes                                 │
│     ├── Performance optimization                            │
│     └── Documentation                                       │
│                                                             │
│  2. SPRINT DEFINITION                                       │
│     Creates: work/sprints/sprint-001.md                     │
│                                                             │
│     Sprint Goal: [Clear, measurable outcome]                │
│     Duration: 1 week (default for solo)                     │
│     Tasks: Linked to bd issues                              │
│                                                             │
│  3. TASK CREATION IN BD                                     │
│     Auto-creates bd issues with:                            │
│     - Clear descriptions                                    │
│     - Dependencies mapped                                   │
│     - Priority set                                          │
│     - Acceptance criteria                                   │
│                                                             │
│  4. RESEARCH PHASE                                          │
│     For each technical decision:                            │
│     - Research best libraries (2025-2026)                   │
│     - Compare options                                       │
│     - Document decision in work/research/                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Sprint Structure

```yaml
# work/sprints/sprint-001.md
Sprint: 001
Goal: "Working authentication and basic UI shell"
Duration: 2026-01-27 to 2026-02-02

Tasks:
  - bd-a1b2: Setup Next.js 15 with TypeScript [foundation]
  - bd-c3d4: Design system page with core components [design]
  - bd-e5f6: Auth with NextAuth.js [feature]
    depends_on: [bd-a1b2]
  - bd-g7h8: Basic navigation layout [ui]
    depends_on: [bd-c3d4]

Definition of Done:
  - [ ] All tasks complete
  - [ ] Tests passing (>80% coverage)
  - [ ] No security vulnerabilities
  - [ ] Design system approved
  - [ ] Demo-able to stakeholder
```

---

### Phase 3: Design System First

**Command:** `/pilot-design`

```
┌─────────────────────────────────────────────────────────────┐
│                 DESIGN SYSTEM FLOW                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. DESIGN TOKENS SETUP                                     │
│     Creates: src/styles/tokens.css                          │
│                                                             │
│     - Colors (primary, secondary, semantic)                 │
│     - Typography scale                                      │
│     - Spacing scale (4px base)                              │
│     - Border radii                                          │
│     - Shadows                                               │
│                                                             │
│  2. CORE COMPONENTS                                         │
│     Creates: src/components/ui/                             │
│                                                             │
│     Button (variants: primary, secondary, outline, ghost)   │
│     Input (text, email, password, number)                   │
│     Select                                                  │
│     Checkbox, Radio, Switch                                 │
│     Card (header, content, footer)                          │
│     Modal/Dialog                                            │
│     Toast/Alert                                             │
│                                                             │
│  3. DESIGN SYSTEM PAGE                                      │
│     Creates: src/app/design-system/page.tsx                 │
│                                                             │
│     - All components showcased                              │
│     - All variants visible                                  │
│     - Interactive examples                                  │
│     - User approval before building features                │
│                                                             │
│  4. COMPONENT REGISTRY                                      │
│     Creates: .claude/pilot/component-registry.json          │
│                                                             │
│     AI references this before creating any new component    │
│     Prevents duplicate buttons, cards, etc.                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Component Registry Format

```json
{
  "components": {
    "Button": {
      "path": "src/components/ui/Button.tsx",
      "variants": ["primary", "secondary", "outline", "ghost", "destructive"],
      "sizes": ["sm", "md", "lg"],
      "props": ["disabled", "loading", "icon", "iconPosition"]
    },
    "Card": {
      "path": "src/components/ui/Card.tsx",
      "subcomponents": ["Card.Header", "Card.Content", "Card.Footer"]
    }
  },
  "patterns": {
    "form-field": "Always use FormField wrapper for label + input + error",
    "data-fetching": "Use SWR for client components, server fetch for RSC"
  }
}
```

---

### Phase 4: Specialized Agents

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                   ┌─────────────────┐                       │
│                   │  ORCHESTRATOR   │                       │
│                   │     AGENT       │                       │
│                   └────────┬────────┘                       │
│                            │                                │
│     ┌──────────┬──────────┼──────────┬──────────┐          │
│     ▼          ▼          ▼          ▼          ▼          │
│ ┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐         │
│ │FRONTEND││BACKEND ││TESTING ││SECURITY││ REVIEW │         │
│ │ AGENT  ││ AGENT  ││ AGENT  ││ AGENT  ││ AGENT  │         │
│ └────────┘└────────┘└────────┘└────────┘└────────┘         │
│                                                             │
│  FRONTEND AGENT                                             │
│  - React/Next.js expertise                                  │
│  - Checks component registry before creating                │
│  - Validates accessibility (WCAG AA)                        │
│  - Ensures responsive design                                │
│  - Uses design tokens only                                  │
│                                                             │
│  BACKEND AGENT                                              │
│  - API design (REST/tRPC)                                   │
│  - Database schema                                          │
│  - Authentication/authorization                             │
│  - Input validation                                         │
│                                                             │
│  TESTING AGENT                                              │
│  - Unit tests (Vitest)                                      │
│  - Integration tests                                        │
│  - E2E tests (Playwright)                                   │
│  - Coverage enforcement (>80%)                              │
│                                                             │
│  SECURITY AGENT                                             │
│  - OWASP Top 10 checks                                      │
│  - Dependency audit                                         │
│  - Secrets scanning                                         │
│  - Input sanitization                                       │
│                                                             │
│  REVIEW AGENT                                               │
│  - Code quality checks                                      │
│  - Pattern compliance                                       │
│  - File size limits                                         │
│  - No duplicate code                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Agent Validation Rules

```yaml
# .claude/pilot/agent-rules.yaml

frontend:
  must:
    - Use Server Components by default
    - Add 'use client' only when needed
    - Check component registry before creating new component
    - Use design tokens, never hardcoded colors/spacing
    - Include loading and error states
    - Pass Lighthouse accessibility audit
  must_not:
    - Use useEffect for data fetching
    - Create duplicate components
    - Use inline styles
    - Ignore mobile responsive design

backend:
  must:
    - Validate all inputs with Zod
    - Use parameterized queries (no string interpolation)
    - Implement rate limiting on public endpoints
    - Log security events
    - Return proper HTTP status codes
  must_not:
    - Expose internal error messages
    - Store secrets in code
    - Skip authentication on protected routes

testing:
  must:
    - Maintain >80% coverage on new code
    - Write E2E tests for critical paths
    - Test error cases, not just happy path
    - Use meaningful test names (should_when_given)
  must_not:
    - Write tests without assertions
    - Mock everything (use real DB in integration)
    - Skip edge cases

security:
  must:
    - Run OWASP scan before merge
    - Check dependencies for vulnerabilities
    - Validate CORS configuration
    - Ensure HTTPS everywhere
  must_not:
    - Allow SQL injection patterns
    - Allow XSS vectors
    - Commit secrets or credentials

code_quality:
  file_limits:
    max_lines: 500
    warning_lines: 300
    max_function_lines: 50
  must:
    - Follow existing patterns
    - Use canonical utilities
    - Keep functions single-purpose
  must_not:
    - Create parallel implementations
    - Exceed file size limits
    - Add magic numbers
```

---

### Phase 5: Testing Strategy

**Command:** `/pilot-test`

```
┌─────────────────────────────────────────────────────────────┐
│                    TESTING FLOW                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  TEST-FIRST DEVELOPMENT                                     │
│                                                             │
│  For each task:                                             │
│  1. AI generates failing tests first                        │
│  2. AI implements code to pass tests                        │
│  3. AI refactors while tests pass                           │
│  4. Human reviews                                           │
│                                                             │
│  COVERAGE TARGETS                                           │
│  ├── Unit tests: 80%                                        │
│  ├── Integration: 70%                                       │
│  └── E2E: Critical paths only                               │
│                                                             │
│  TOOLS                                                      │
│  ├── Unit/Integration: Vitest                               │
│  ├── E2E: Playwright                                        │
│  ├── Visual Regression: Chromatic (optional)                │
│  └── Security: npm audit + custom rules                     │
│                                                             │
│  E2E TESTS FOR UI                                           │
│  ├── Layout validation                                      │
│  ├── Component rendering                                    │
│  ├── User flow completion                                   │
│  ├── Responsive breakpoints                                 │
│  └── Accessibility checks                                   │
│                                                             │
│  CONTINUOUS TESTING                                         │
│  ├── Pre-commit: Lint + affected unit tests                 │
│  ├── PR: Full unit + integration                            │
│  ├── Merge to main: Full suite + E2E                        │
│  └── Nightly: Visual regression                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### Phase 6: Code Quality Guardrails

```
┌─────────────────────────────────────────────────────────────┐
│                    QUALITY GATES                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  BEFORE CODE GENERATION                                     │
│  ├── Load codebase context                                  │
│  ├── Check component registry                               │
│  ├── Load coding guidelines                                 │
│  └── Identify existing patterns                             │
│                                                             │
│  DURING CODE GENERATION                                     │
│  ├── Validate against guidelines                            │
│  ├── Check for duplicates                                   │
│  ├── Enforce file size limits                               │
│  └── Use canonical patterns                                 │
│                                                             │
│  AFTER CODE GENERATION                                      │
│  ├── Lint & format                                          │
│  ├── Type check                                             │
│  ├── Security scan                                          │
│  ├── Test execution                                         │
│  ├── Coverage check                                         │
│  └── Human review                                           │
│                                                             │
│  SEMANTIC DUPLICATE DETECTION                               │
│  ├── >70% similarity → Block, suggest reuse                 │
│  ├── >50% similarity → Warning with reference               │
│  └── New utility file → Require search confirmation         │
│                                                             │
│  FILE SIZE ENFORCEMENT                                      │
│  ├── >300 lines → Warning, suggest split                    │
│  ├── >500 lines → Block, require split plan                 │
│  └── >50 line function → Require extraction                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## New Skills

| Skill | Purpose |
|-------|---------|
| `/pilot-init` | Initialize new project with smart questions |
| `/pilot-design` | Create/update design system |
| `/pilot-sprint` | Plan next sprint with bd tasks |
| `/pilot-test` | Generate tests for current feature |
| `/pilot-security` | Run security audit |
| `/pilot-quality` | Run code quality checks |

---

## Implementation Roadmap

### v0.0.3 - Foundation (COMPLETED - 2026-01-21)
- [x] `/pilot-init` - Project initialization with questions
- [x] `PROJECT_BRIEF.md` generation
- [x] Roadmap generation
- [x] `/pilot-sprint` - Sprint planning with bd tasks
- [x] Research phase automation (integrated into /pilot-sprint)

### v0.0.4 - Design System (COMPLETED - 2026-01-21)
- [x] `/pilot-design` - Design system generation
- [x] Component registry
- [x] Design system page template
- [x] shadcn/ui integration

### v0.0.5 - Testing (COMPLETED - 2026-01-21)
- [x] `/pilot-test` - Test generation skill
- [x] Vitest integration (config template, setup, unit/component templates)
- [x] Playwright E2E templates
- [x] Coverage enforcement (in vitest config)
- [x] Action-oriented UX improvements (/pilot-next, /pilot-start)

### v0.0.6 - Agents ✅ COMPLETED
- [x] Frontend agent validation rules (.claude/pilot/rules/frontend.yaml)
- [x] Backend agent validation rules (.claude/pilot/rules/backend.yaml)
- [x] Security agent rules (.claude/pilot/rules/security.yaml)
- [x] Review agent rules (.claude/pilot/rules/review.yaml)
- [x] Parallel execution skill (/pilot-parallel)

### v0.0.7 - Production Ready
- [ ] Full agent orchestration
- [ ] Quality gates
- [ ] Duplicate detection
- [ ] Performance benchmarks

---

## Technical Specifications

### Directory Structure (After Init)

```
project/
├── .beads/                    # Task database
├── .claude/
│   ├── skills/pilot-*/        # Pilot AGI skills
│   └── pilot/
│       ├── config.json        # Framework config
│       ├── component-registry.json
│       ├── agent-rules.yaml
│       └── hooks/
├── work/
│   ├── PROJECT_BRIEF.md       # Project definition
│   ├── ROADMAP.md             # High-level phases
│   ├── sprints/               # Sprint definitions
│   ├── research/              # Technical decisions
│   └── specs/                 # Feature specs
├── runs/
│   └── YYYY-MM-DD.md          # Session logs
├── src/
│   ├── app/                   # Next.js App Router
│   ├── components/
│   │   ├── ui/                # Design system components
│   │   └── features/          # Feature components
│   ├── lib/                   # Utilities
│   ├── hooks/                 # Custom hooks
│   └── types/                 # TypeScript definitions
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
└── CLAUDE.md                  # Agent contract
```

### Tech Stack Recommendations (2025-2026)

| Category | Recommended | Alternative |
|----------|-------------|-------------|
| Framework | Next.js 15+ | Remix, Nuxt |
| UI Components | shadcn/ui + Radix | Headless UI |
| Styling | Tailwind CSS | CSS Modules |
| State (Server) | SWR / TanStack Query | Built-in fetch |
| State (Client) | Zustand | Jotai |
| Forms | React Hook Form + Zod | Formik |
| Testing Unit | Vitest | Jest |
| Testing E2E | Playwright | Cypress |
| Auth | NextAuth.js / Clerk | Auth0 |
| Database | PostgreSQL + Prisma | MongoDB |
| API | tRPC / Server Actions | REST |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Init to first commit | <15 minutes |
| Test coverage new code | >80% |
| Security vulnerabilities | 0 critical/high |
| Duplicate code | <5% |
| File size violations | 0 |
| User approval before build | 100% |

---

## References

### Research Sources
- [Addy Osmani - LLM Coding Workflow 2026](https://addyosmani.com/blog/ai-coding-workflow/)
- [Anthropic - Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [GitHub - Spec-Driven Development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- [Qodo - State of AI Code Quality 2025](https://www.qodo.ai/reports/state-of-ai-code-quality/)
- [GitClear - AI Code Quality Research](https://www.gitclear.com/ai_assistant_code_quality_2025_research)
- [JetBrains - Coding Guidelines for AI Agents](https://blog.jetbrains.com/idea/2025/05/coding-guidelines-for-your-ai-agents/)
- [patterns.dev - React 2026](https://www.patterns.dev/react/react-2026/)
- [Baymard - AI Heuristic UX Evaluation](https://baymard.com/blog/ai-heuristic-evaluations)

### Tools Referenced
- [beads (bd)](https://github.com/steveyegge/beads) - Task management
- [shadcn/ui](https://ui.shadcn.com/) - Component library
- [Vitest](https://vitest.dev/) - Testing framework
- [Playwright](https://playwright.dev/) - E2E testing
- [Chromatic](https://www.chromatic.com/) - Visual testing

---

*Last Updated: 2026-01-21*
