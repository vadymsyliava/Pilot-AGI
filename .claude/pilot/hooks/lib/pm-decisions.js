/**
 * PM Decisions — AI-assisted judgment calls for the PM daemon
 *
 * Part of Phase 4.4 (Pilot AGI-ock)
 *
 * Architecture:
 *   - Mechanical decisions (spawn, health, cleanup, budget) = pure Node.js
 *   - Judgment decisions (review, decompose, conflict, complexity) = one-shot `claude -p` calls
 *
 * Each judgment function:
 *   1. Constructs a focused prompt
 *   2. Calls `claude -p --output-format json` as a child process
 *   3. Parses the JSON response
 *   4. Returns structured result
 *
 * This keeps the PM daemon running indefinitely as pure Node.js
 * with no Claude session and no context limits.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_TIMEOUT_MS = 60000;  // 60s max per AI call
const MAX_DIFF_CHARS = 8000;      // Truncate diffs to keep prompt small
const MAX_CONTEXT_CHARS = 4000;   // Truncate context

// ============================================================================
// CORE: One-shot claude -p call
// ============================================================================

/**
 * Execute a one-shot claude -p call with JSON output.
 *
 * @param {string} prompt - The prompt to send
 * @param {object} opts - Options
 * @param {string} opts.projectRoot - Project root for cwd
 * @param {number} opts.timeoutMs - Timeout in ms
 * @returns {{ success: boolean, result?: object, error?: string, raw?: string }}
 */
function callClaude(prompt, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const timeoutMs = opts.timeoutMs || CLAUDE_TIMEOUT_MS;

  const args = ['-p', prompt, '--output-format', 'json'];

  try {
    const output = execFileSync('claude', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PILOT_DAEMON_SPAWNED: '1'
      }
    });

    // claude --output-format json wraps response in a JSON envelope
    // The actual text content is in the result field
    try {
      const envelope = JSON.parse(output);
      // Extract the text content from the envelope
      const text = envelope.result || envelope.content || envelope.text || output;

      // Try to parse the text as JSON (the AI should return JSON)
      try {
        const parsed = typeof text === 'string' ? JSON.parse(text) : text;
        return { success: true, result: parsed, decision_type: 'judgment' };
      } catch (innerParseErr) {
        // Text wasn't JSON — return raw text
        return { success: true, result: { raw_text: text }, decision_type: 'judgment' };
      }
    } catch (outerParseErr) {
      // Output wasn't a JSON envelope — try direct JSON parse
      try {
        const parsed = JSON.parse(output);
        return { success: true, result: parsed, decision_type: 'judgment' };
      } catch (e) {
        return { success: true, result: { raw_text: output.trim() }, decision_type: 'judgment' };
      }
    }
  } catch (e) {
    return {
      success: false,
      error: e.message?.substring(0, 500) || 'Unknown error',
      decision_type: 'judgment'
    };
  }
}

// ============================================================================
// JUDGMENT FUNCTIONS
// ============================================================================

/**
 * AI-assisted diff review.
 * Reviews a git diff for a task and returns approve/reject with issues.
 *
 * @param {string} taskId - The task ID
 * @param {string} diff - Git diff content
 * @param {object} opts - { projectRoot, taskTitle, taskDescription }
 * @returns {{ approved: boolean, issues: string[], summary: string, decision_type: string }}
 */
function reviewDiff(taskId, diff, opts = {}) {
  const truncatedDiff = diff.substring(0, MAX_DIFF_CHARS);
  const context = opts.taskDescription
    ? `Task: ${taskId} — ${opts.taskTitle || ''}\nDescription: ${opts.taskDescription.substring(0, MAX_CONTEXT_CHARS)}`
    : `Task: ${taskId}`;

  const prompt = `You are a code reviewer for a software project. Review this diff and respond with ONLY valid JSON (no markdown, no explanation outside the JSON).

${context}

Diff:
\`\`\`
${truncatedDiff}
\`\`\`

Respond with this exact JSON format:
{
  "approved": true/false,
  "issues": ["issue 1", "issue 2"],
  "summary": "one line summary of the review"
}

Rules:
- Approve if the diff is clean, follows good practices, and matches the task
- Flag issues: security problems, missing error handling, incomplete implementation, code smells
- Be concise — each issue should be one sentence`;

  const result = callClaude(prompt, { projectRoot: opts.projectRoot });

  if (!result.success) {
    return {
      approved: false,
      issues: [`AI review failed: ${result.error}`],
      summary: 'Review could not be completed',
      decision_type: 'judgment'
    };
  }

  const r = result.result;
  return {
    approved: typeof r.approved === 'boolean' ? r.approved : false,
    issues: Array.isArray(r.issues) ? r.issues : [],
    summary: r.summary || 'Review complete',
    decision_type: 'judgment'
  };
}

/**
 * AI-assisted task decomposition.
 * Breaks a task description into subtasks.
 *
 * @param {string} taskDescription - Full task description
 * @param {object} context - { projectRoot, existingFiles, milestone }
 * @returns {{ subtasks: Array<{title: string, description: string, complexity: string}>, decision_type: string }}
 */
function decomposeTask(taskDescription, context = {}) {
  const truncatedDesc = taskDescription.substring(0, MAX_CONTEXT_CHARS);
  const filesContext = context.existingFiles
    ? `\nRelevant files:\n${context.existingFiles.slice(0, 20).join('\n')}`
    : '';

  const prompt = `You are a project manager decomposing a software task. Break this task into smaller subtasks and respond with ONLY valid JSON.

Task description:
${truncatedDesc}
${filesContext}

Respond with this exact JSON format:
{
  "subtasks": [
    {
      "title": "Short imperative title",
      "description": "What needs to be done",
      "complexity": "S|M|L"
    }
  ]
}

Rules:
- Each subtask should be independently completable
- Use S (< 1 hour), M (1-4 hours), L (4+ hours) for complexity
- Order subtasks by dependency (first subtask has no dependencies)
- Keep to 3-7 subtasks`;

  const result = callClaude(prompt, { projectRoot: context.projectRoot });

  if (!result.success) {
    return {
      subtasks: [],
      error: result.error,
      decision_type: 'judgment'
    };
  }

  const r = result.result;
  return {
    subtasks: Array.isArray(r.subtasks) ? r.subtasks : [],
    decision_type: 'judgment'
  };
}

/**
 * AI-assisted conflict resolution suggestion.
 *
 * @param {object} conflictInfo - { file, ours, theirs, base, taskId }
 * @param {object} opts - { projectRoot }
 * @returns {{ suggestion: string, strategy: string, confidence: string, decision_type: string }}
 */
function resolveConflict(conflictInfo, opts = {}) {
  // Phase 5.2: Try semantic resolution first
  try {
    const resolver = require('./merge-conflict-resolver');
    const registry = require('./conflict-parser-registry').getRegistry();

    if (conflictInfo.file && registry.isSupported(conflictInfo.file)) {
      const oursIntent = resolver.parseCommitIntent(conflictInfo.oursCommitMsg || '');
      const theirsIntent = resolver.parseCommitIntent(conflictInfo.theirsCommitMsg || '');

      // Build a conflict region from the provided ours/theirs
      const conflict = {
        ours: conflictInfo.ours || '',
        theirs: conflictInfo.theirs || '',
        base: conflictInfo.base || undefined
      };

      const classification = resolver.classifyConflict(conflict, conflictInfo.file);
      const resolution = resolver.resolveConflictRegion(
        conflict, classification, { oursIntent, theirsIntent }, conflictInfo.file
      );

      if (resolution.resolved !== null && resolution.confidence >= 0.60) {
        const strategyMap = {
          combine: 'merge', interleave: 'merge',
          prefer_ours: 'ours', prefer_theirs: 'theirs',
          escalate: 'manual'
        };
        return {
          strategy: strategyMap[resolution.strategy] || 'merge',
          suggestion: `Semantic resolution (${classification.type}): ${resolution.strategy}`,
          confidence: resolution.confidence >= 0.85 ? 'high' : 'medium',
          conflict_type: classification.type,
          resolution_strategy: resolution.strategy,
          semantic_confidence: resolution.confidence,
          resolved_content: resolution.resolved,
          decision_type: 'semantic'
        };
      }
    }
  } catch (e) {
    // Semantic resolution not available — fall through to AI
  }

  // Fallback: AI-assisted resolution with enhanced context
  const planContext = conflictInfo.taskId ? (() => {
    try {
      const resolver = require('./merge-conflict-resolver');
      const plan = resolver.loadPlanContext(conflictInfo.taskId, opts.projectRoot);
      return plan ? `\nPlan context: ${JSON.stringify(plan).substring(0, 500)}` : '';
    } catch (e) { return ''; }
  })() : '';

  const prompt = `You are resolving a git merge conflict. Analyze the conflict and suggest a resolution. Respond with ONLY valid JSON.

File: ${conflictInfo.file || 'unknown'}
Task: ${conflictInfo.taskId || 'unknown'}${planContext}

Our changes:
\`\`\`
${(conflictInfo.ours || '').substring(0, 2000)}
\`\`\`

Their changes:
\`\`\`
${(conflictInfo.theirs || '').substring(0, 2000)}
\`\`\`
${conflictInfo.base ? `\nBase (original):\n\`\`\`\n${conflictInfo.base.substring(0, 1000)}\n\`\`\`\n` : ''}
Respond with this exact JSON format:
{
  "strategy": "ours|theirs|merge|manual",
  "suggestion": "description of what to do",
  "confidence": "high|medium|low"
}

Rules:
- "ours" = keep our changes, "theirs" = keep their changes
- "merge" = combine both (explain how in suggestion)
- "manual" = too complex for auto-resolution (explain why)
- Set confidence to "low" if unsure`;

  const result = callClaude(prompt, { projectRoot: opts.projectRoot });

  if (!result.success) {
    return {
      strategy: 'manual',
      suggestion: `AI resolution failed: ${result.error}`,
      confidence: 'low',
      decision_type: 'judgment'
    };
  }

  const r = result.result;
  return {
    strategy: ['ours', 'theirs', 'merge', 'manual'].includes(r.strategy) ? r.strategy : 'manual',
    suggestion: r.suggestion || 'No suggestion available',
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
    decision_type: 'judgment'
  };
}

/**
 * AI-assisted complexity assessment.
 *
 * @param {string} taskDescription - Full task description
 * @param {object} opts - { projectRoot }
 * @returns {{ complexity: string, reasoning: string, estimated_steps: number, decision_type: string }}
 */
function assessComplexity(taskDescription, opts = {}) {
  const truncatedDesc = taskDescription.substring(0, MAX_CONTEXT_CHARS);

  const prompt = `You are estimating the complexity of a software task. Respond with ONLY valid JSON.

Task:
${truncatedDesc}

Respond with this exact JSON format:
{
  "complexity": "S|M|L",
  "reasoning": "brief explanation",
  "estimated_steps": 3
}

Rules:
- S = simple (1-3 steps, < 1 hour, single file changes)
- M = medium (3-7 steps, 1-4 hours, multiple files)
- L = large (7+ steps, 4+ hours, cross-cutting changes)
- estimated_steps = approximate number of implementation steps`;

  const result = callClaude(prompt, { projectRoot: opts.projectRoot });

  if (!result.success) {
    // Fallback: estimate from description length
    const wordCount = taskDescription.split(/\s+/).length;
    const fallbackComplexity = wordCount > 200 ? 'L' : wordCount > 80 ? 'M' : 'S';
    return {
      complexity: fallbackComplexity,
      reasoning: `AI assessment failed, heuristic based on description length (${wordCount} words)`,
      estimated_steps: fallbackComplexity === 'S' ? 2 : fallbackComplexity === 'M' ? 5 : 8,
      decision_type: 'mechanical'
    };
  }

  const r = result.result;
  return {
    complexity: ['S', 'M', 'L'].includes(r.complexity) ? r.complexity : 'M',
    reasoning: r.reasoning || 'No reasoning provided',
    estimated_steps: typeof r.estimated_steps === 'number' ? r.estimated_steps : 5,
    decision_type: 'judgment'
  };
}

// ============================================================================
// PLAN CONFIDENCE ASSESSMENT (Phase 5.1)
// ============================================================================

/**
 * AI-assisted plan confidence assessment.
 * Used for medium-confidence plans (notify_approve tier) to get a second
 * opinion before proceeding, or to score plans that need judgment.
 *
 * @param {string} taskId - The task ID
 * @param {object} plan - Plan with steps, files, summary
 * @param {object} opts - { projectRoot, taskTitle, taskDescription }
 * @returns {{ confidence: number, risk_level: string, concerns: string[], recommendation: string, decision_type: string }}
 */
function assessPlanConfidence(taskId, plan, opts = {}) {
  const truncatedPlan = JSON.stringify(plan).substring(0, MAX_CONTEXT_CHARS);
  const context = opts.taskDescription
    ? `Task: ${taskId} — ${opts.taskTitle || ''}\nDescription: ${opts.taskDescription.substring(0, MAX_CONTEXT_CHARS)}`
    : `Task: ${taskId}`;

  const prompt = `You are assessing the risk and confidence of a software implementation plan. Respond with ONLY valid JSON.

${context}

Plan:
\`\`\`json
${truncatedPlan}
\`\`\`

Respond with this exact JSON format:
{
  "confidence": 0.75,
  "risk_level": "low|medium|high",
  "concerns": ["concern 1", "concern 2"],
  "recommendation": "approve|review|reject"
}

Rules:
- confidence: 0.0-1.0 where 1.0 = completely safe routine change
- risk_level: "low" = tests/docs/config, "medium" = logic/features, "high" = auth/data/infra
- concerns: list specific risks (empty array if none)
- recommendation: "approve" = safe to auto-approve, "review" = human should glance, "reject" = human must review`;

  const result = callClaude(prompt, { projectRoot: opts.projectRoot });

  if (!result.success) {
    // Fallback: return conservative assessment
    return {
      confidence: 0.5,
      risk_level: 'medium',
      concerns: [`AI assessment failed: ${result.error}`],
      recommendation: 'review',
      decision_type: 'judgment'
    };
  }

  const r = result.result;
  return {
    confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
    risk_level: ['low', 'medium', 'high'].includes(r.risk_level) ? r.risk_level : 'medium',
    concerns: Array.isArray(r.concerns) ? r.concerns : [],
    recommendation: ['approve', 'review', 'reject'].includes(r.recommendation) ? r.recommendation : 'review',
    decision_type: 'judgment'
  };
}

// ============================================================================
// DECISION ROUTING
// ============================================================================

/**
 * Classify a decision as mechanical or judgment.
 *
 * @param {string} decisionType - Type of decision
 * @returns {'mechanical' | 'judgment'}
 */
function classifyDecision(decisionType) {
  const MECHANICAL = new Set([
    'spawn_agent', 'kill_agent', 'health_check', 'reap_dead',
    'budget_check', 'pressure_check', 'session_cleanup',
    'lock_management', 'heartbeat', 'state_persist',
    'tick', 'status_query', 'process_table'
  ]);

  return MECHANICAL.has(decisionType) ? 'mechanical' : 'judgment';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core
  callClaude,
  classifyDecision,

  // Judgment functions
  reviewDiff,
  decomposeTask,
  resolveConflict,
  assessComplexity,
  assessPlanConfidence,

  // Constants (for testing)
  CLAUDE_TIMEOUT_MS,
  MAX_DIFF_CHARS,
  MAX_CONTEXT_CHARS
};
