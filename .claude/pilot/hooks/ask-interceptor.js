#!/usr/bin/env node

/**
 * AskUserQuestion Interceptor Hook
 *
 * Blocks worker agents from asking the human questions directly.
 * Instead, routes the question to PM via the message bus and tells
 * the agent to use messaging.sendRequest() for decisions.
 *
 * PM terminal sessions are exempt — they can ask the human freely.
 *
 * Part of Phase 3.1 — Agent Identity & PM Coordination
 */

const fs = require('fs');
const path = require('path');

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
    // No stdin — allow through
    process.exit(0);
  }

  const toolName = hookInput.tool_name || '';
  if (toolName !== 'AskUserQuestion') {
    process.exit(0);
  }

  // Check autonomy mode first — in full autonomy, block ALL questions
  try {
    const { loadPolicy } = require('./lib/policy');
    const policy = loadPolicy();

    if (policy.autonomy?.mode === 'full') {
      const toolInput = hookInput.tool_input || {};
      const questions = toolInput.questions || [];
      const questionTexts = questions.map(q => q.question || '').filter(Boolean);
      const questionSummary = questionTexts.length > 0
        ? questionTexts.join('; ')
        : 'a question';

      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `AUTONOMOUS MODE: Do not ask questions. Make the best decision based on the plan, code patterns, and task description.\n\n` +
            `Blocked question: "${questionSummary}"\n\n` +
            `Decision guidelines:\n` +
            `1. Follow the approved plan exactly\n` +
            `2. Match existing code patterns and conventions\n` +
            `3. If truly blocked (e.g. missing dependency, broken infra), log the error and stop\n` +
            `4. For ambiguous choices, pick the simpler option that matches codebase conventions\n\n` +
            `Continue executing. Do not stop for clarification.`
        }
      };
      console.log(JSON.stringify(output));
      process.exit(0);
    }
  } catch (policyErr) {
    // Policy load failed — fall through to PM check
  }

  // Check if this is a PM session — PM can ask humans freely
  try {
    const orchestrator = require('./lib/orchestrator');
    const session = require('./lib/session');

    const pmState = orchestrator.loadPmState();
    if (!pmState) {
      // No PM initialized — allow through (solo mode)
      process.exit(0);
    }

    // Find current session ID from env or session state
    const currentSessionId = findCurrentSessionId();

    if (!currentSessionId) {
      // Can't determine session — allow through
      process.exit(0);
    }

    // If this IS the PM session, allow through
    if (currentSessionId === pmState.pm_session_id) {
      process.exit(0);
    }

    // This is a worker agent — block and redirect to PM
    const toolInput = hookInput.tool_input || {};
    const questions = toolInput.questions || [];

    // Extract the question text for the deny reason
    const questionTexts = questions.map(q => q.question || '').filter(Boolean);
    const questionSummary = questionTexts.length > 0
      ? questionTexts.join('; ')
      : 'a question';

    // Route the question to PM via message bus
    try {
      const messaging = require('./lib/messaging');
      messaging.sendRequest(currentSessionId, pmState.pm_session_id, 'agent_question', {
        agent_session: currentSessionId,
        questions: questions,
        question_summary: questionSummary,
        context: {
          tool_input: toolInput
        }
      }, { priority: 'normal', ttl_ms: 300000 });
    } catch (busErr) {
      // Best effort — still block regardless
    }

    // Block with helpful redirect message
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `WORKER AGENT: Do not ask the human directly. You are a worker agent managed by PM.\n\n` +
          `Your question "${questionSummary}" has been routed to PM via the message bus.\n\n` +
          `How to handle decisions:\n` +
          `1. For task/approach questions — make the best decision based on the plan and codebase\n` +
          `2. For blocking questions — send via message bus: messaging.sendRequest(sessionId, 'PM', 'question', { question: '...' })\n` +
          `3. For clarifications — check the task description, plan, and existing code\n\n` +
          `PM will review your question and respond via the message bus. Continue working on what you can.`
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);

  } catch (e) {
    // If any infrastructure fails, allow through (don't block work)
    process.exit(0);
  }
}

/**
 * Find the current session ID for this terminal.
 * Checks env var first, then finds most recent active session.
 */
function findCurrentSessionId() {
  // Check environment variable (set by session-start hook)
  if (process.env.PILOT_SESSION_ID) {
    return process.env.PILOT_SESSION_ID;
  }

  // Fallback: find the most recent session by PID matching
  const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
  if (!fs.existsSync(sessDir)) return null;

  try {
    const ppid = process.ppid;
    const files = fs.readdirSync(sessDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'))
      .sort().reverse();

    // First pass: try to match by parent PID
    for (const f of files) {
      try {
        const sess = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (sess.pid === ppid || sess.parent_pid === ppid) {
          return sess.session_id;
        }
      } catch (e) { continue; }
    }

    // Second pass: most recent active session
    for (const f of files) {
      try {
        const sess = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (sess.status === 'active') {
          return sess.session_id;
        }
      } catch (e) { continue; }
    }
  } catch (e) {
    return null;
  }

  return null;
}

main().catch(() => {
  // Fail gracefully — allow through
  process.exit(0);
});
