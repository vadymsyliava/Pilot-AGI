#!/usr/bin/env node

/**
 * Pilot AGI User Prompt Submit Hook (Semantic Guardian)
 *
 * GOVERNANCE HOOK: Detects new work and enforces task-first workflow.
 *
 * This hook is a UNIQUE DIFFERENTIATOR for Pilot AGI. It provides:
 * - Semantic detection of new work requests (vs questions/reviews)
 * - Context injection for Claude to self-evaluate scope
 * - Guidance toward proper task creation workflow
 *
 * Governance purpose:
 * - Prevents "shadow work" (work done without task tracking)
 * - Ensures all significant work has a task in bd
 * - Provides project context for informed decisions
 *
 * Non-blocking: This hook injects context but doesn't block prompts.
 * Claude evaluates the context and decides how to proceed.
 *
 * Strategy:
 * - Quick heuristics filter obvious non-work prompts (questions, etc.)
 * - For uncertain prompts, inject project + task context
 * - Claude semantically evaluates if this is new work
 * - Token-efficient: only inject ~300 tokens for uncertain prompts
 */

const fs = require('fs');
const path = require('path');
const { loadPolicy } = require('./lib/policy');
const cache = require('./lib/cache');
const session = require('./lib/session');

// =============================================================================
// QUICK HEURISTICS (instant, no tokens)
// =============================================================================

/**
 * Check if prompt is a Pilot/GSD command (always pass through)
 */
function isPilotCommand(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  return trimmed.startsWith('/pilot') ||
         trimmed.startsWith('/gsd') ||
         trimmed.startsWith('bd ') ||
         trimmed === 'bd';
}

/**
 * Check if prompt is clearly a question (pass through)
 */
function isQuestion(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  const questionStarters = [
    'what ', 'where ', 'when ', 'why ', 'how ', 'who ', 'which ',
    'can you explain', 'tell me about', 'show me', 'help me understand',
    'list ', 'describe ', 'summarize', 'explain '
  ];

  return questionStarters.some(q => trimmed.startsWith(q)) ||
         trimmed.endsWith('?');
}

/**
 * Check if prompt is a short acknowledgement (pass through)
 */
function isAcknowledgement(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  const acknowledgements = [
    'yes', 'no', 'ok', 'okay', 'sure', 'thanks', 'thank you',
    'got it', 'understood', 'continue', 'proceed', 'go ahead',
    'approve', 'approved', 'lgtm', 'ship it'
  ];

  return acknowledgements.includes(trimmed) || trimmed.length < 5;
}

/**
 * Check if prompt is a code review/explanation request (pass through)
 */
function isReviewRequest(prompt) {
  const trimmed = prompt.trim().toLowerCase();
  const reviewPatterns = [
    'review ', 'look at ', 'check ', 'analyze ', 'read ',
    'what does this', 'what is this', 'explain this'
  ];

  return reviewPatterns.some(p => trimmed.startsWith(p));
}

/**
 * Check if prompt references an existing task (pass through)
 */
function referencesTask(prompt) {
  // Matches bd-xxx, Pilot AGI-xxx, or task ID patterns
  return /\b(bd-\w+|pilot\s*agi-\w+|\[[\w-]+\])/i.test(prompt);
}

/**
 * Determine if we should inject guardian context
 * Returns true if prompt might be new work request
 */
function shouldInjectGuardian(prompt, activeTask) {
  // Always pass these through without injection
  if (isPilotCommand(prompt)) return false;
  if (isQuestion(prompt)) return false;
  if (isAcknowledgement(prompt)) return false;
  if (isReviewRequest(prompt)) return false;
  if (referencesTask(prompt)) return false;

  // If there's an active task, minimal injection needed
  if (activeTask) return false;

  // Prompt might be new work - inject context for Claude to evaluate
  return true;
}

// =============================================================================
// SESSION AWARENESS (Session Guardian)
// =============================================================================

/**
 * Build a session awareness summary using lockfile-based liveness.
 * Shows agent count and what peers are working on.
 *
 * @param {string|null} currentSessionId - This session's ID (to mark as "this session")
 * @returns {string|null} Session awareness context string, or null if only one session
 */
function buildSessionAwareness(currentSessionId) {
  try {
    const policy = loadPolicy();
    const maxSessions = policy.session?.max_concurrent_sessions || 6;

    // Use getActiveSessions() which triggers _reapZombies() — ensures
    // dead-PID sessions are cleaned up before we count them.
    // This is the fix for zombie sessions appearing in the awareness display.
    const liveSessions = session.getActiveSessions(currentSessionId);
    // Re-add current session to the list for display purposes
    try {
      const currentState = session.getAllSessionStates().find(s => s.session_id === currentSessionId);
      if (currentState && currentState.status === 'active') {
        liveSessions.unshift(currentState);
      }
    } catch (e) { /* best effort */ }

    if (liveSessions.length <= 1) return null;

    const lines = [`Active agents: ${liveSessions.length} of ${maxSessions} max`];

    for (const s of liveSessions) {
      const isCurrent = s.session_id === currentSessionId;
      const label = isCurrent ? '(this session)' : '';
      const task = s.claimed_task
        ? `working on [${s.claimed_task}]`
        : 'idle';
      lines.push(`  ${s.session_id} ${label}: ${task}`);
    }

    return lines.join('\n');
  } catch (e) {
    return null;
  }
}

/**
 * Find the current session ID via PID-based resolution (multi-agent safe).
 */
function getCurrentSessionId() {
  try {
    const session = require('./lib/session');
    return session.resolveCurrentSession();
  } catch (e) {
    return null;
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
    // No stdin or invalid JSON
    process.exit(0);
  }

  const prompt = hookInput.prompt || '';

  // Update heartbeat (keeps session alive)
  try {
    session.heartbeat();
  } catch (e) {
    // Best effort - don't block on heartbeat failure
  }

  // Skip if empty prompt
  if (!prompt.trim()) {
    process.exit(0);
  }

  // Load policy
  let policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    // No policy, allow everything
    process.exit(0);
  }

  // Skip if detect_new_scope is disabled
  if (!policy.enforcement?.detect_new_scope) {
    process.exit(0);
  }

  // Get active task
  const activeTask = cache.getActiveTask();

  // Build session awareness (shows peer agents — only when multiple sessions)
  const currentSessionId = getCurrentSessionId();
  const sessionAwareness = buildSessionAwareness(currentSessionId);

  // Decide whether to inject guardian context
  if (!shouldInjectGuardian(prompt, activeTask)) {
    // Quick heuristics passed - no injection needed
    if (activeTask) {
      // Remind about active task + session awareness
      let context = `Active task: [${activeTask.id}] ${activeTask.title}`;
      if (sessionAwareness) {
        context += '\n' + sessionAwareness;
      }
      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context
        }
      };
      console.log(JSON.stringify(output));
    } else if (sessionAwareness) {
      // No active task but multiple sessions — still show awareness
      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: sessionAwareness
        }
      };
      console.log(JSON.stringify(output));
    }
    process.exit(0);
  }

  // Uncertain prompt with no active task - inject guardian context
  // Claude will semantically evaluate if this is new work
  // Pass prompt to enable smart task suggestion
  let guardianContext = cache.buildGuardianContext(prompt);
  if (sessionAwareness) {
    guardianContext += '\n' + sessionAwareness;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: guardianContext
    }
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => {
  // Fail gracefully - allow prompt through
  process.exit(0);
});
