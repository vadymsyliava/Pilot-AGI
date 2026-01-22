#!/usr/bin/env node

/**
 * Quality Gate Runner
 *
 * PreToolUse hook that runs quality checks before git commits.
 * Integrates with Claude Code's hook system to block commits
 * that don't meet quality standards.
 */

const fs = require('fs');
const path = require('path');

// Gate modules
const fileSizeGate = require('./gates/file-size');
const lintGate = require('./gates/lint');
const secretsGate = require('./gates/secrets');
const securityGate = require('./gates/security');
const typeCheckGate = require('./gates/type-check');
const duplicateGate = require('./gates/duplicate');
const reporter = require('./lib/reporter');

/**
 * Check if command is a git commit
 */
function isGitCommit(command) {
  return command && /\bgit\s+commit\b/.test(command);
}

/**
 * Load configuration
 */
function loadConfig() {
  const configPaths = [
    path.join(process.cwd(), '.claude', 'pilot', 'config.json'),
    path.join(process.env.HOME || '', '.claude', 'pilot', 'config.json'),
    path.join(__dirname, '..', 'config.default.json')
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config.quality_gates || {};
      } catch (e) {
        // Continue to next path
      }
    }
  }

  // Default configuration
  return {
    enabled: true,
    file_size: { enabled: true, warn: 300, block: 500 },
    lint: { enabled: true, timeout: 30000 },
    secrets: { enabled: true },
    type_check: { enabled: true, timeout: 30000 }
  };
}

/**
 * Run all enabled quality gates with timing
 */
async function runGates(config) {
  const results = [];
  const gates = [
    { name: 'file-size', fn: fileSizeGate, config: config.file_size },
    { name: 'secrets', fn: secretsGate, config: config.secrets },
    { name: 'security', fn: securityGate, config: config.security },
    { name: 'duplicate', fn: duplicateGate, config: config.duplicate },
    { name: 'lint', fn: lintGate, config: config.lint },
    { name: 'type-check', fn: typeCheckGate, config: config.type_check }
  ];

  const totalStart = process.hrtime.bigint();

  for (const gate of gates) {
    if (gate.config?.enabled === false) {
      continue;
    }

    const startTime = process.hrtime.bigint();
    try {
      const result = await gate.fn.check(gate.config || {});
      const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
      results.push({
        gate: gate.name,
        duration_ms: Math.round(duration),
        ...result
      });
    } catch (error) {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
      results.push({
        gate: gate.name,
        duration_ms: Math.round(duration),
        status: 'error',
        message: error.message
      });
    }
  }

  const totalDuration = Number(process.hrtime.bigint() - totalStart) / 1e6;

  return { results, total_duration_ms: Math.round(totalDuration) };
}

/**
 * Main entry point
 */
async function main() {
  let input = '';

  // Read stdin
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    // Not JSON input, pass through
    process.exit(0);
  }

  // Only intercept Bash tool calls that are git commits
  if (data.tool_name !== 'Bash') {
    process.exit(0);
  }

  const command = data.tool_input?.command || '';

  if (!isGitCommit(command)) {
    process.exit(0);
  }

  // Load configuration and run gates
  const config = loadConfig();

  if (config.enabled === false) {
    process.exit(0);
  }

  const { results, total_duration_ms } = await runGates(config);
  const report = reporter.format(results, total_duration_ms);

  // Check for failures
  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');

  if (failures.length > 0) {
    // Block the commit
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: report.summary,
        additionalContext: report.details
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  if (warnings.length > 0) {
    // Allow but add context
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: `Quality gate warnings:\n${report.warnings}`
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // All gates passed silently
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
