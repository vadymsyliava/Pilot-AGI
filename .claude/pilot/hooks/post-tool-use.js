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
  // Use PID-based resolution (multi-agent safe)
  try {
    const session = require('./lib/session');
    return session.resolveCurrentSession();
  } catch (e) {
    return null;
  }
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
        const taskId = idMatch ? idMatch[1] : 'unknown';
        emitBusEvent(sessionId, 'task_complete', {
          task_id: taskId,
          completed_by: sessionId
        });

        // Phase 8.1: Auto-backup soul + record assessment on task close
        try {
          const sessFile = require('path').join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
          if (require('fs').existsSync(sessFile)) {
            const sess = JSON.parse(require('fs').readFileSync(sessFile, 'utf8'));
            const role = sess.role;
            if (role) {
              const soulLifecycle = require('./lib/soul-auto-lifecycle');
              soulLifecycle.onTaskClose(role, taskId);
            }
          }
        } catch (e) { /* best effort */ }
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
// AGENT MEMORY RECORDING (Phase 3.7)
// =============================================================================

/**
 * Record significant events to per-agent persistent memory.
 * Detects patterns, errors, and discoveries from tool results.
 * Fire-and-forget — failure here never blocks the agent.
 *
 * @param {string} sessionId
 * @param {object} hookInput - { tool_name, tool_input, tool_result }
 */
function recordAgentMemory(sessionId, hookInput) {
  try {
    const memory = require('./lib/memory');
    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const toolResult = hookInput.tool_result || '';
    const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

    // Resolve agent role from session state
    const agentType = resolveAgentType(sessionId);
    if (!agentType) return;

    // Detect git commit — record as discovery (code pattern learned)
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      const cmd = toolInput.command;

      if (/git\s+commit\b/.test(cmd) && !resultStr.includes('nothing to commit')) {
        const msgMatch = cmd.match(/-m\s+["']([^"']*)/);
        const msg = msgMatch ? msgMatch[1].substring(0, 100) : '';
        const taskMatch = msg.match(/\[([^\]]+)\]/);
        memory.recordDiscovery(agentType, {
          type: 'commit',
          detail: msg,
          task_id: taskMatch ? taskMatch[1] : null
        });
        return;
      }

      // Detect test failures — record as error
      if (/npm\s+test|vitest|jest|pytest|npx\s+vitest/.test(cmd) &&
          /FAIL|Error:|AssertionError|test failed/i.test(resultStr)) {
        memory.recordError(agentType, {
          error_type: 'test_failure',
          context: cmd.substring(0, 100),
          resolution: null,
          task_id: getClaimedTaskId(sessionId)
        });
        return;
      }

      // Detect build/lint errors
      if (/npm\s+run\s+(?:build|lint)|tsc|eslint/.test(cmd) &&
          /error|Error/i.test(resultStr) && resultStr.length > 50) {
        memory.recordError(agentType, {
          error_type: 'build_failure',
          context: cmd.substring(0, 100),
          resolution: null,
          task_id: getClaimedTaskId(sessionId)
        });
        return;
      }
    }
  } catch (e) {
    // Never block — agent memory is best-effort
  }
}

/**
 * Resolve the agent type (role) for the current session.
 * Falls back to 'backend' if no role is set.
 */
function resolveAgentType(sessionId) {
  try {
    const sessFile = path.join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
    if (fs.existsSync(sessFile)) {
      const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      return data.role || 'backend';
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Get the claimed task ID for a session.
 */
function getClaimedTaskId(sessionId) {
  try {
    const sessFile = path.join(process.cwd(), '.claude/pilot/state/sessions', `${sessionId}.json`);
    if (fs.existsSync(sessFile)) {
      const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      return data.claimed_task || null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// =============================================================================
// AUTO-CHECKPOINT (Phase 3.5)
// =============================================================================

/**
 * Automatically save a checkpoint when pressure threshold is hit.
 * Gathers minimal context from session state and claimed task.
 *
 * Security: Uses execFileSync (no shell) for all subprocess calls.
 *
 * @param {string} sessionId
 * @param {object} stats - { calls, bytes, pct_estimate }
 * @returns {{ version: number }|null} - checkpoint version or null on failure
 */
function autoCheckpoint(sessionId, stats) {
  try {
    const { execFileSync } = require('child_process');
    const checkpoint = require('./lib/checkpoint');

    // Gather task context from session state file
    const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
    let taskId = null;
    let taskTitle = null;

    try {
      const sessFiles = fs.readdirSync(sessDir)
        .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
        .sort().reverse();

      for (const f of sessFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
          if (data.session_id === sessionId && data.claimed_task) {
            taskId = data.claimed_task;
            break;
          }
        } catch (e) { continue; }
      }
    } catch (e) {
      // No session state — continue without task context
    }

    // Try to get task title from bd (best-effort, fast timeout)
    // Security: execFileSync with array args — no shell injection
    if (taskId) {
      try {
        const result = execFileSync('bd', ['show', taskId, '--json'], {
          encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
        });
        const task = JSON.parse(result);
        taskTitle = task.title || null;
      } catch (e) {
        // Skip title — not critical
      }
    }

    // Get recently modified files from git (fast, no network)
    // Security: execFileSync with array args — no shell injection
    let filesModified = [];
    try {
      const gitFiles = execFileSync('git', ['diff', '--name-only', 'HEAD~3'], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (gitFiles) {
        filesModified = gitFiles.split('\n').filter(Boolean).slice(0, 20);
      }
    } catch (e) {
      try {
        const gitFiles = execFileSync('git', ['diff', '--name-only'], {
          encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (gitFiles) {
          filesModified = gitFiles.split('\n').filter(Boolean).slice(0, 20);
        }
      } catch (e2) {
        // No git context — continue
      }
    }

    const result = checkpoint.saveCheckpoint(sessionId, {
      task_id: taskId,
      task_title: taskTitle,
      files_modified: filesModified,
      current_context: `Auto-checkpoint at ${stats.pct_estimate}% pressure (${stats.calls} tool calls)`,
      tool_call_count: stats.calls,
      output_bytes: stats.bytes
    });

    if (result.success) {
      // Reset pressure counters after successful checkpoint
      const pressureMod = require('./lib/pressure');
      pressureMod.resetPressure(sessionId);
      return { version: result.version };
    }

    return null;
  } catch (e) {
    // Auto-checkpoint is best-effort — never block
    return null;
  }
}

/**
 * Enqueue a compact request via the stdin-injector action queue.
 * The user-prompt-submit hook will detect this and prompt the agent.
 *
 * @param {string} sessionId
 * @param {object} stats - pressure stats at time of checkpoint
 */
function enqueueCompactRequest(sessionId, stats) {
  try {
    const injector = require('./lib/stdin-injector');
    injector.enqueueAction(process.cwd(), {
      type: 'compact_request',
      priority: 'blocking',
      source_event_id: `auto-checkpoint-${sessionId}`,
      data: {
        session_id: sessionId,
        pressure_pct: stats.pct_estimate,
        reason: 'Auto-checkpoint saved, context compaction recommended'
      }
    });
  } catch (e) {
    // Best-effort — if queue fails, the nudge message is still shown
  }
}

// =============================================================================
// EXIT-ON-CHECKPOINT (Phase 4.3)
// =============================================================================

/**
 * Check if this is a daemon-spawned agent that should exit on checkpoint.
 * Only daemon-spawned agents exit; interactive sessions compact instead.
 *
 * @returns {boolean}
 */
function shouldExitOnCheckpoint() {
  // Only daemon-spawned agents do exit-on-checkpoint
  if (process.env.PILOT_DAEMON_SPAWNED !== '1') return false;

  try {
    const respawnTracker = require('./lib/respawn-tracker');
    return respawnTracker.isRespawnEnabled();
  } catch (e) {
    return false;
  }
}

/**
 * Execute exit-on-checkpoint: save handoff state, emit bus event, then exit.
 *
 * @param {string} sessionId
 * @param {object} stats - pressure stats
 * @param {number} checkpointVersion - version from auto-checkpoint
 */
function exitOnCheckpoint(sessionId, stats, checkpointVersion) {
  const taskId = getClaimedTaskId(sessionId);
  if (!taskId) return; // No task claimed — can't do handoff

  try {
    // 1. Run pre-exit protocol (stash changes, write handoff state)
    const taskHandoff = require('./lib/task-handoff');
    taskHandoff.preExitProtocol({
      sessionId,
      taskId,
      projectRoot: process.cwd(),
      checkpointData: {
        tool_call_count: stats.calls,
        output_bytes: stats.bytes,
        current_context: `Exit-on-checkpoint at ${stats.pct_estimate}% pressure`
      },
      exitReason: 'checkpoint_respawn'
    });

    // 2. Emit checkpoint_exit bus event for PM daemon
    emitBusEvent(sessionId, 'checkpoint_exit', {
      task_id: taskId,
      session_id: sessionId,
      pressure_pct: stats.pct_estimate,
      checkpoint_version: checkpointVersion,
      exit_reason: 'checkpoint_respawn'
    });

    // 3. Log the exit
    try {
      const session = require('./lib/session');
      session.logEvent({
        type: 'checkpoint_exit',
        session_id: sessionId,
        task_id: taskId,
        pressure_pct: stats.pct_estimate,
        checkpoint_version: checkpointVersion
      });
    } catch (e) { /* best effort */ }

    // 4. Exit the process cleanly
    // Use a short delay to allow the bus event to be written
    setTimeout(() => {
      process.exit(0);
    }, 100);
  } catch (e) {
    // If exit-on-checkpoint fails, fall back to compact request
    // This ensures the agent doesn't get stuck
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

  // Update heartbeat (keeps session alive during active work)
  // Fix: post-tool-use was missing heartbeat, causing sessions to go stale
  // during long tool calls (>2min) when only pre-tool-use updated it.
  try {
    const session = require('./lib/session');
    session.heartbeat();
  } catch (e) {
    // Best effort - don't block on heartbeat failure
  }

  // Estimate output bytes from tool result
  const toolResult = hookInput.tool_result || '';
  const outputBytes = typeof toolResult === 'string'
    ? Buffer.byteLength(toolResult, 'utf8')
    : Buffer.byteLength(JSON.stringify(toolResult), 'utf8');

  // Record the tool call
  const pressure = require('./lib/pressure');
  pressure.recordToolCall(sessionId, outputBytes);

  // --- Phase 3.11: Per-task cost tracking ---
  // Record cost against the agent's claimed task (fire-and-forget).
  try {
    const taskId = getClaimedTaskId(sessionId);
    if (taskId) {
      const costTracker = require('./lib/cost-tracker');
      costTracker.recordTaskCost(sessionId, taskId, outputBytes);
    }
  } catch (e) {
    // Best effort — never block tool execution
  }

  // Check if we should nudge
  const threshold = getThreshold();
  const { shouldNudge, pressure: stats } = pressure.checkAndNudge(sessionId, threshold);

  if (shouldNudge) {
    // --- Phase 3.5: Auto-checkpoint at pressure threshold ---
    // Instead of just nudging, automatically save a checkpoint.
    const autoResult = autoCheckpoint(sessionId, stats);

    if (autoResult) {
      // --- Phase 4.3: Exit-on-checkpoint for daemon-spawned agents ---
      // If this is a daemon-spawned agent with respawn enabled,
      // exit cleanly instead of compacting. PM daemon will respawn.
      if (shouldExitOnCheckpoint()) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            notification: `Context pressure at ${stats.pct_estimate}% — checkpoint saved (v${autoResult.version}). Exiting for PM daemon respawn.`
          }
        };
        console.log(JSON.stringify(output));

        // This will exit the process after saving handoff state
        exitOnCheckpoint(sessionId, stats, autoResult.version);
        return; // Won't reach here — process exits above
      }

      // Non-daemon agents: enqueue a compact request (original behavior)
      enqueueCompactRequest(sessionId, stats);

      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          notification: `Context pressure at ${stats.pct_estimate}% — auto-checkpoint saved (v${autoResult.version}). A compact request has been queued. Run /compact to free context, then resume automatically.`
        }
      };
      console.log(JSON.stringify(output));
    } else {
      // Fallback: if auto-checkpoint fails, nudge manually
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          notification: `Context pressure at ${stats.pct_estimate}% (${stats.calls} tool calls, ~${Math.round(stats.bytes / 1024)}KB). Auto-checkpoint failed — please run /pilot-checkpoint manually.`
        }
      };
      console.log(JSON.stringify(output));
    }
  }

  // --- Status events for PM Watcher (Pilot AGI-v1k) ---
  // Emit structured events to bus.jsonl for autonomous coordination.
  // Only emit when meaningful state changes are detected.
  emitStatusEvents(sessionId, hookInput);

  // --- Agent memory recording (Phase 3.7) ---
  // Record significant events to per-agent persistent memory.
  // Best-effort, never blocks tool execution.
  recordAgentMemory(sessionId, hookInput);

  process.exit(0);
}

main().catch(() => {
  // Fail gracefully — never block tool execution
  process.exit(0);
});
