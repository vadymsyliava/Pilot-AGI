#!/usr/bin/env node

/**
 * Pilot AGI PostToolUse Hook
 *
 * OBSERVABILITY HOOK: Fires after every tool use.
 *
 * Responsibilities:
 * 1. Context pressure tracking (Phase 2.2.1)
 *    - Increments tool call counter, accumulates output bytes
 *    - At configurable threshold (~60%), nudges agent to checkpoint
 *
 * 2. Structured status events for PM Watcher (Pilot AGI-v1k)
 *    - Emits events to bus.jsonl when significant things happen
 *    - Events: step_complete, task_complete, blocked, error
 *    - Enables autonomous PM-Executor coordination
 *
 * Performance: Must be fast. Reads/writes small JSON files.
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
// STATUS EVENT EMISSION (for PM Watcher — Pilot AGI-v1k)
// =============================================================================

/**
 * Emit structured status events to bus.jsonl.
 * Detects significant state changes from tool results and session state.
 *
 * Events are fire-and-forget — failure here never blocks the agent.
 */
function emitStatusEvents(sessionId, hookInput) {
  try {
    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const toolResult = hookInput.tool_result || '';
    const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

    // Detect bd close (task completion)
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      const cmd = toolInput.command;

      // bd close <id> or bd update <id> --status closed
      if (/bd\s+close\b/.test(cmd) || /bd\s+update\b.*--status\s+closed/.test(cmd)) {
        const idMatch = cmd.match(/bd\s+(?:close|update)\s+["']?([^\s"']+)/);
        emitBusEvent(sessionId, 'task_complete', {
          task_id: idMatch ? idMatch[1] : 'unknown',
          completed_by: sessionId
        });
        return;
      }

      // bd update <id> --status in_progress (task claimed)
      if (/bd\s+update\b.*--status\s+in_progress/.test(cmd)) {
        const idMatch = cmd.match(/bd\s+update\s+["']?([^\s"']+)/);
        emitBusEvent(sessionId, 'task_claimed', {
          task_id: idMatch ? idMatch[1] : 'unknown',
          claimed_by: sessionId
        });
        return;
      }
    }

    // Detect git commit (step completion signal)
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      const cmd = toolInput.command;
      if (/git\s+commit\b/.test(cmd) && !resultStr.includes('nothing to commit')) {
        // Extract commit message for context
        const msgMatch = cmd.match(/-m\s+["']([^"']*)/);
        emitBusEvent(sessionId, 'step_complete', {
          commit_msg: msgMatch ? msgMatch[1].substring(0, 100) : 'unknown',
          agent: sessionId
        });
        return;
      }
    }

    // Detect test failures or errors (potential blocked state)
    if (toolName === 'Bash' && resultStr.length > 0) {
      // Check for test failures
      if (/FAIL|Error:|AssertionError|test failed/i.test(resultStr) &&
          /npm\s+test|vitest|jest|pytest/.test(toolInput.command || '')) {
        emitBusEvent(sessionId, 'error', {
          type: 'test_failure',
          command: (toolInput.command || '').substring(0, 200),
          snippet: resultStr.substring(0, 300),
          agent: sessionId
        });
        return;
      }
    }
  } catch (e) {
    // Never block — status events are best-effort
  }
}

/**
 * Append a structured event to bus.jsonl.
 * Lightweight — does not use the full messaging library to avoid overhead.
 */
function emitBusEvent(sessionId, topic, data) {
  try {
    const busPath = path.join(process.cwd(), '.claude/pilot/messages/bus.jsonl');
    const busDir = path.dirname(busPath);

    if (!fs.existsSync(busDir)) {
      fs.mkdirSync(busDir, { recursive: true });
    }

    const event = {
      id: `E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
      type: 'notify',
      from: sessionId,
      to: 'PM',
      priority: 'normal',
      topic,
      ttl_ms: 300000,
      payload: { action: topic, data }
    };

    fs.appendFileSync(busPath, JSON.stringify(event) + '\n');
  } catch (e) {
    // Best-effort — never throw
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

  // --- Status events for PM Watcher (Pilot AGI-v1k) ---
  // Emit structured events to bus.jsonl for autonomous coordination.
  // Only emit when meaningful state changes are detected.
  emitStatusEvents(sessionId, hookInput);

  process.exit(0);
}

main().catch(() => {
  // Fail gracefully — never block tool execution
  process.exit(0);
});
