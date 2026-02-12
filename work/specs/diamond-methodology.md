# Diamond Design Methodology

**Phase**: 2.6 | **Task**: Pilot AGI-i48
**Consumed by**: Phase 2.8 (Design Agent), all future UI work

---

## Double Diamond Framework (Adapted for Developer Tools)

The Double Diamond (UK Design Council, 2005/2019) structures design into two diamonds of divergent/convergent thinking.

### Diamond 1 — Problem Space

**Discover (Divergent)**: Research broadly
- Developer interviews (workflow, pain points, mental models)
- Session analysis (how users interact with Claude Code)
- Competitive analysis (Cursor, Aider, Copilot Workspace)
- Community mining (Discord, GitHub issues, Reddit)

**Define (Convergent)**: Synthesize and frame
- Persona development (3-5 developer archetypes)
- Journey mapping (discovery → mastery)
- Jobs-to-be-Done hierarchy
- Design principles derivation
- Problem statement crafting

### Diamond 2 — Solution Space

**Develop (Divergent)**: Generate and prototype
- Token structure exploration (multiple format proposals)
- Component API design (variant approaches)
- Documentation format experimentation
- Tooling proof-of-concepts

**Deliver (Convergent)**: Refine and ship
- Finalize token values and component specs
- Build production components
- Create documentation
- Launch with pilot users, measure, iterate

---

## Developer Personas

### Persona 1: Solo Indie Developer

| Field | Value |
|-------|-------|
| Role | Full-stack solo developer |
| Experience | 3-7 years |
| Company | Side project / bootstrapped SaaS |
| AI Attitude | Enthusiast, early adopter |
| Primary Goal | Ship fast with AI automation |
| Pain Point | Context switching between planning and coding |
| Tool Adoption | Tries everything, keeps what sticks |

> "I just want to describe what I want and have it built correctly."

### Persona 2: Startup Engineer

| Field | Value |
|-------|-------|
| Role | Senior engineer at seed/Series A startup |
| Experience | 5-10 years |
| Company | Fast-paced, resource-constrained team of 3-8 |
| AI Attitude | Pragmatist |
| Primary Goal | Reliable output with clear debugging |
| Pain Point | Onboarding teammates to AI workflow |
| Tool Adoption | Evaluates carefully, values documentation |

> "It needs to work reliably. I can't debug mysterious AI failures during a sprint."

### Persona 3: Enterprise Architect

| Field | Value |
|-------|-------|
| Role | Staff/Principal engineer at enterprise |
| Experience | 10+ years |
| Company | Large org with compliance requirements |
| AI Attitude | Skeptic/Pragmatist |
| Primary Goal | Governance, audit trails, reproducibility |
| Pain Point | Justifying AI tools to management and security |
| Tool Adoption | Slow, requires proof of compliance |

> "Show me the audit trail. Who approved what, and when?"

### Persona 4: Open Source Maintainer

| Field | Value |
|-------|-------|
| Role | OSS project maintainer |
| Experience | 5+ years |
| Company | Community-driven project |
| AI Attitude | Pragmatist |
| Primary Goal | Scale review and contribution management |
| Pain Point | Review overhead, inconsistent PR quality |
| Tool Adoption | Values community alignment |

> "Can AI help me review PRs consistently without losing the project's voice?"

### Persona 5: AI Researcher/Experimenter

| Field | Value |
|-------|-------|
| Role | Developer pushing AI tool boundaries |
| Experience | 3-8 years |
| Company | Varies |
| AI Attitude | Enthusiast, power user |
| Primary Goal | Maximum flexibility and extensibility |
| Pain Point | Tools are too opinionated |
| Tool Adoption | Early adopter, customizes everything |

> "I want to compose agent behaviors, not be locked into a predefined workflow."

---

## Developer Journey Map Template

```
PHASE: [Name]
──────────────────────────────────
Actions:    [What they do]
Touchpoints: [Where they interact]
Thoughts:   [What they're thinking]
Emotions:   [How they feel]
Pain Points: [Problems encountered]
Opportunities: [Where to improve]
```

### Pilot AGI Journey Phases

1. **Discovery** — Hear about tool, read docs, watch demo
2. **Installation** — Clone, install, check requirements
3. **First Project** — Try on small task, follow tutorial
4. **Daily Integration** — Use for real work, customize workflow
5. **Advanced Usage** — Multi-agent orchestration, complex tasks
6. **Advocacy** — Recommend, contribute back

---

## Jobs-to-be-Done Template

```
When [SITUATION/CONTEXT]
I want to [MOTIVATION/GOAL]
So I can [EXPECTED OUTCOME]
```

### Core JTBD for Pilot AGI

**High-level**: "Get complex features delivered faster with AI help"

**Mid-level jobs**:
- Break down features into manageable tasks
- Delegate appropriate tasks to AI agents
- Monitor progress and quality
- Handle failures and edge cases
- Integrate AI outputs into codebase

**Task-level jobs**:
- Define task scope and acceptance criteria
- Choose which agent type for which task
- Review and approve agent plans
- Debug when agent gets stuck
- Commit agent work with proper attribution

---

## Research Report Template

```markdown
# [Feature/Phase] Research Report
Date: YYYY-MM-DD

## Executive Summary
- Key findings (3-5 bullets)
- Recommended direction
- Confidence level (low/medium/high)

## Research Questions
1. [Question]

## Methodology
- Participants: N=[number]
- Methods: [interviews/surveys/analytics]
- Limitations: [what we couldn't test]

## Findings
### Finding 1: [Title]
- Evidence: [quotes, data]
- Frequency: [how common]
- Impact: [high/medium/low]

## Implications for Design
- Must have: [critical requirements]
- Should have: [important but not blocking]
- Could have: [nice to have]
- Won't have (this phase): [explicitly out of scope]

## Recommended Next Steps
1. [Action item]
```
