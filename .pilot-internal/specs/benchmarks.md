# Performance Benchmarks Specification

Defines performance metrics and targets for Pilot AGI workflows.

## Metrics

### 1. Init to First Commit

**Target:** < 15 minutes

**Measurement:** Wall clock time from `/pilot-init` start to first successful `git commit`.

**Components measured:**
- Project setup questions
- PROJECT_BRIEF.md generation
- ROADMAP.md creation
- First task planning
- First implementation
- Quality gates
- Commit

**How to measure:** Session capsule timestamps (start → first commit).

### 2. Test Coverage

**Target:** > 80% on new code

**Measurement:** Vitest v8 coverage on files changed in commit.

**Configuration:**
```json
{
  "coverage": {
    "provider": "v8",
    "thresholds": {
      "statements": 80,
      "branches": 80,
      "functions": 80,
      "lines": 80
    }
  }
}
```

**How to measure:** `npm run test:coverage` with JSON reporter.

### 3. Security Vulnerabilities

**Target:** 0 critical/high

**Measurement:** `npm audit --json` results.

**Blocking severities:** critical, high
**Warning severities:** moderate

**How to measure:** Security gate in quality-gate.js.

### 4. Duplicate Code

**Target:** < 5%

**Measurement:** Token-based similarity detection.

**Thresholds:**
- Block: > 70% similarity
- Warn: > 50% similarity
- Minimum lines: 15

**How to measure:** Duplicate gate in quality-gate.js.

### 5. File Size Violations

**Target:** 0 violations

**Measurement:** Line count of code files.

**Thresholds:**
- Warn: > 300 lines
- Block: > 500 lines

**How to measure:** File-size gate in quality-gate.js.

## Configuration

Located in `.claude/pilot/config.default.json`:

```json
{
  "benchmarks": {
    "enabled": true,
    "targets": {
      "init_to_commit_minutes": 15,
      "test_coverage_percent": 80,
      "security_critical_high": 0,
      "duplicate_percent": 5,
      "file_size_violations": 0
    },
    "tracking": {
      "log_to_session": true,
      "metrics_file": "work/metrics/benchmarks.json"
    }
  }
}
```

## Quality Gates

Gates run automatically before each `git commit`:

| Gate | Check | Block | Warn |
|------|-------|-------|------|
| file-size | Line count | > 500 | > 300 |
| secrets | Hardcoded credentials | Any found | - |
| security | npm audit vulnerabilities | critical/high | moderate |
| duplicate | Token similarity | > 70% | > 50% |
| lint | ESLint/project linter | Errors | Warnings |
| type-check | TypeScript compilation | Errors | - |

## Timing Collection

Quality gate execution times are captured via `process.hrtime()`:

```javascript
const startTime = process.hrtime.bigint();
const result = await gate.fn.check(config);
const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
```

Each gate result includes `duration_ms` for tracking.

## Metrics Storage

Metrics are stored in `work/metrics/benchmarks.json`:

```json
[
  {
    "timestamp": "2026-01-21T12:00:00.000Z",
    "quality_gate_duration_ms": 1234,
    "test_coverage_percent": 85,
    "security_critical_high": 0,
    "file_size_violations": 0
  }
]
```

Last 100 entries are retained for trend analysis.

## Reporting

Use benchmark utilities in `.claude/pilot/hooks/lib/benchmark.js`:

- `formatReport(metrics)` - Console-formatted report
- `saveMetrics(metrics)` - Append to metrics file
- `loadRecentMetrics(count)` - Load recent entries
- `calculateTrend(metrics, field)` - Trend analysis

## CI Integration

For CI pipelines, quality gates exit with non-zero on failure:

```bash
# Run quality gates
node .claude/pilot/hooks/quality-gate.js < input.json

# Check exit code
if [ $? -ne 0 ]; then
  echo "Quality gates failed"
  exit 1
fi
```

## Session Capsule Format

Metrics are logged to session capsules (`runs/YYYY-MM-DD.md`):

```markdown
### Performance Metrics
- Quality gates: 1234ms
  - file-size: 50ms
  - secrets: 100ms
  - security: 800ms
  - duplicate: 150ms
  - lint: 0ms (skipped)
  - type-check: 134ms
- Coverage: 85%
- Violations: 0
```
