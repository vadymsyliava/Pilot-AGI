# Task Classifier

Rules for automatically classifying tasks and routing them to appropriate agents.

## Classification Algorithm

```
1. Extract keywords from task description
2. Match against agent indicators
3. Analyze file patterns (if known)
4. Calculate confidence scores
5. Select agents above threshold
```

## Keyword Patterns

### Frontend Agent Triggers

**High Confidence (0.8+)**
- "create component"
- "build ui"
- "design page"
- "add button"
- "implement form"
- "style"
- "css"
- "tailwind"
- "responsive"

**Medium Confidence (0.5-0.8)**
- "component"
- "page"
- "ui"
- "layout"
- "modal"
- "dialog"
- "animation"
- "theme"
- "dark mode"

**Low Confidence (0.3-0.5)**
- "display"
- "show"
- "view"
- "render"

### Backend Agent Triggers

**High Confidence (0.8+)**
- "create api"
- "add endpoint"
- "database"
- "server action"
- "authentication"
- "authorization"
- "prisma"
- "migration"

**Medium Confidence (0.5-0.8)**
- "api"
- "endpoint"
- "route"
- "query"
- "mutation"
- "fetch data"
- "middleware"
- "validation"

**Low Confidence (0.3-0.5)**
- "server"
- "data"
- "request"
- "response"

### Testing Agent Triggers

**High Confidence (0.8+)**
- "write test"
- "add tests"
- "test coverage"
- "unit test"
- "e2e test"
- "vitest"
- "playwright"

**Medium Confidence (0.5-0.8)**
- "test"
- "testing"
- "coverage"
- "mock"
- "fixture"
- "assertion"

### Security Agent Triggers

**High Confidence (0.8+)**
- "security audit"
- "vulnerability"
- "xss"
- "injection"
- "authentication security"
- "owasp"
- "penetration"

**Medium Confidence (0.5-0.8)**
- "security"
- "secure"
- "encrypt"
- "permission"
- "access control"
- "sanitize"

### Review Agent Triggers

**High Confidence (0.8+)**
- "code review"
- "review changes"
- "quality check"
- "refactor"
- "cleanup"

**Medium Confidence (0.5-0.8)**
- "review"
- "improve"
- "optimize"
- "lint"
- "fix code smell"

## File Pattern Matching

### Frontend Files
```
components/**/*
app/**/page.tsx
app/**/layout.tsx
pages/**/*.tsx
*.module.css
*.module.scss
styles/**/*
```
→ Confidence: +0.4 for Frontend Agent

### Backend Files
```
app/api/**/*
api/**/*
server/**/*
lib/db/**/*
services/**/*
prisma/**/*
*.server.ts
```
→ Confidence: +0.4 for Backend Agent

### Test Files
```
**/*.test.ts
**/*.test.tsx
**/*.spec.ts
**/*.spec.tsx
tests/**/*
__tests__/**/*
e2e/**/*
```
→ Confidence: +0.4 for Testing Agent

## Compound Patterns

Some tasks clearly need multiple agents:

### Full-Stack Feature
Keywords: "feature", "implement", "build" + file patterns in both frontend and backend
→ Frontend + Backend (parallel)

### Secure API
Keywords: "api" + "security" OR "auth"
→ Backend + Security

### Reviewed Component
Keywords: "component" + "review" OR "quality"
→ Frontend + Review

## Confidence Calculation

```javascript
function calculateConfidence(task, agent) {
  let score = 0;

  // Keyword matching
  for (const keyword of agent.task_indicators) {
    if (task.toLowerCase().includes(keyword)) {
      score += getKeywordWeight(keyword, agent);
    }
  }

  // File pattern matching (if files known)
  if (taskFiles) {
    for (const file of taskFiles) {
      if (matchesPattern(file, agent.file_patterns)) {
        score += 0.4;
        break;
      }
    }
  }

  // Explicit mention
  if (task.toLowerCase().includes(agent.name.toLowerCase())) {
    score += 1.0;
  }

  return Math.min(score, 1.0);
}
```

## Selection Rules

1. **Single Agent**: If one agent has confidence >= 0.7 and others < 0.5
2. **Multi Agent**: If multiple agents have confidence >= 0.5
3. **Fallback**: If no agent >= 0.5, use Review Agent
4. **Override**: User can always specify agents explicitly

## Examples

### Example 1
**Task**: "Create a login form component with validation"
- Frontend: 0.9 (component, form, validation in UI context)
- Backend: 0.2 (validation could be backend, but context is UI)
- **Selected**: Frontend only

### Example 2
**Task**: "Add user registration API with password hashing"
- Backend: 0.9 (API, password, hashing)
- Security: 0.6 (password, hashing triggers security)
- **Selected**: Backend (primary), Security (post-review)

### Example 3
**Task**: "Build dashboard page with data from API"
- Frontend: 0.8 (page, dashboard)
- Backend: 0.6 (API, data)
- **Selected**: Backend then Frontend (sequential - API first)

### Example 4
**Task**: "Refactor authentication to use sessions"
- Backend: 0.8 (authentication, sessions)
- Security: 0.7 (authentication is security-sensitive)
- **Selected**: Backend + Security (parallel review)
