# Sprint M5-Wave1B

**Goal**: Complete M5 Wave 1 — autonomous test generation and real-time external notifications
**Duration**: Feb 12 – Feb 18, 2026
**Status**: Planning

---

## Phases

### Phase 5.3: Autonomous Test Generation
From ROADMAP.md Milestone 5, Stream A

- Coverage-aware: analyze what's untested after each code change
- Strategy per change type: new function → unit test, bug fix → regression test, refactor → snapshot test
- Framework auto-detection (Vitest, Jest, Mocha, pytest, Go test)
- Quality gate: generated tests must pass and cover changed lines
- Integrated into `/pilot-exec` as sub-step after code changes

### Phase 5.9: Real-Time Notification & Mobile Approval
From ROADMAP.md Milestone 5, Stream C

- Channels: Slack webhook, Discord webhook, Email (SMTP), system notification
- Approval flow: escalation → notification → one-click approve/reject → timeout escalation
- Morning report delivery to configured channel
- Priority-based routing: critical → immediate; info → batch digest

---

## Tasks

| # | Task | Phase | Status | Dependencies |
|---|------|-------|--------|--------------|
| 1 | Change Analyzer — detect change type from git diff | 5.3 | pending | - |
| 2 | Framework Detector — auto-detect project test framework | 5.3 | pending | - |
| 3 | Test Generator Engine — AI-powered test generation via claude -p | 5.3 | pending | #1, #2 |
| 4 | Coverage Gate — verify generated tests pass and cover changes | 5.3 | pending | #3 |
| 5 | Pilot-Exec Integration — auto-generate tests after code changes | 5.3 | pending | #3, #4 |
| 6 | Tests — Autonomous test generation E2E | 5.3 | pending | #1-#5 |
| 7 | Notification Channel Adapters — Slack, Discord, Email, System | 5.9 | pending | - |
| 8 | Notification Router — priority-based routing and batching | 5.9 | pending | #7 |
| 9 | Escalation Integration — wire notifications into escalation engine | 5.9 | pending | #7, #8 |
| 10 | Policy Configuration — notification channels and routing rules | 5.9 | pending | - |
| 11 | Tests — Notification system E2E | 5.9 | pending | #7-#10 |

---

## Definition of Done

- [ ] All tasks complete
- [ ] Tests passing (>80% coverage on new code)
- [ ] No security vulnerabilities (no hardcoded secrets, webhook URLs from config)
- [ ] Demo criteria met
- [ ] Code reviewed

---

## Research

### Phase 5.3 — Test Generation
- **Change detection**: Parse `git diff --name-only --diff-filter=ACMR` for changed files, `git diff` for content
- **Change classification**: Heuristic from diff — new file = new_function, deleted lines + added lines = bug_fix, same line count = refactor
- **Framework detection**: Scan package.json devDeps for vitest/jest/mocha, look for pytest.ini, go.mod
- **Test generation**: One-shot `claude -p` with diff + framework info, returns runnable test file
- **Existing infra**: /pilot-test skill has Vitest templates, project uses Node.js `--test` runner

### Phase 5.9 — Notifications
- **Slack**: Incoming webhook POST with Block Kit JSON (buttons for approve/reject)
- **Discord**: Webhook POST with embeds (no interactive buttons without bot)
- **Email**: Nodemailer (zero deps, industry standard, 13M+ weekly downloads)
- **System**: node-notifier wraps terminal-notifier for macOS, cross-platform
- **Architecture**: Adapter pattern — common NotificationAdapter interface, factory creates per config
- **Priority routing**: Critical → all channels immediate, Warning → primary only, Info → batch digest
- **Approval flow**: Slack buttons POST to PM Hub callback endpoint, resolve escalation

---

## Notes

- Phase 5.3 and 5.9 are independent (no cross-dependencies), can be parallelized
- Tasks #1, #2, #7, #10 have no dependencies and can start immediately
- Existing escalation.js already has human-level escalation — Phase 5.9 adds external delivery
- No external dependencies needed (Slack/Discord are HTTP POST, nodemailer optional)
- Discord interactive buttons require a bot (not just webhook) — initial version uses embeds with URL links

---

*Created by Pilot AGI /pilot-sprint*
