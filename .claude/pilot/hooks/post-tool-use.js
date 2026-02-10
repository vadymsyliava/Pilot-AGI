#!/usr/bin/env node

/**
 * Pilot AGI PostToolUse Hook (Phase 2.2.1 - Context Pressure Tracking)
 *
 * OBSERVABILITY HOOK: Tracks context window usage after each tool call.
 *
 * This hook fires after every tool use and:
 * 1. Increments the tool call counter for the session
 * 2. Accumulates estimated output bytes
 * 3. At configurable threshold (~60%), nudges the agent to checkpoint
 *
 * The nudge is a one-time notification per threshold band (60%, 70%, 80%...).
 * It does NOT block tool execution — it only provides awareness.
 *
 * Performance: This must be fast. It reads/writes a small JSON counter file.
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// SESSION DISCOVERY
// =============================================================================

/**
 * Find the current session ID.
 * Checks environment variable first, then finds most recent active session.
 */
function getCurrentSessionId() {
  // Check environment variable (set by session-start hook)
  if (process.env.PILOT_SESSION_ID) {
    return process.env.PILOT_SESSION_ID;
  }

  // Fall back to finding most recent session file
  const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
  if (!fs.existsSync(sessDir)) return null;

  try {
    const files = fs.readdirSync(sessDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
      .sort()
      .reverse();

    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (data.status === 'active') {
          return data.session_id;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    // ignore
  }

  return null;
}

/**
 * Load checkpoint policy from policy.yaml.
 * Returns threshold percentage (default 60).
 */
function getThreshold() {
  try {
    const { loadPolicy } = require('./lib/policy');
    const policy = loadPolicy();
    return policy.checkpoint?.pressure_threshold_pct || 60;
  } catch (e) {
    return 60;
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Read stdin for hook input
  let hookInput = {};
  try {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    if (inputData.trim()) {
      hookInput = JSON.parse(inputData);
    }
  } catch (e) {
    // No stdin or invalid JSON — exit silently
    process.exit(0);
  }

  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    process.exit(0);
  }

  // Estimate output bytes from tool result
  const toolResult = hookInput.tool_result || '';
  const outputBytes = typeof toolResult === 'string'
    ? Buffer.byteLength(toolResult, 'utf8')
    : Buffer.byteLength(JSON.stringify(toolResult), 'utf8');

  // Record the tool call
  const pressure = require('./lib/pressure');
  pressure.recordToolCall(sessionId, outputBytes);

  // Check if we should nudge
  const threshold = getThreshold();
  const { shouldNudge, pressure: stats } = pressure.checkAndNudge(sessionId, threshold);

  if (shouldNudge) {
    // Output a nudge message that gets injected into the conversation
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        notification: `Context pressure at ${stats.pct_estimate}% (${stats.calls} tool calls, ~${Math.round(stats.bytes / 1024)}KB). Consider running /pilot-checkpoint to save your working state before context compaction.`
      }
    };
    console.log(JSON.stringify(output));
  }

  process.exit(0);
}

main().catch(() => {
  // Fail gracefully — never block tool execution
  process.exit(0);
});
