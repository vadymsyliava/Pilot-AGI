/**
 * PM Brain — on-demand PM intelligence via claude -p
 *
 * Spawns short-lived claude -p with full PM knowledge base.
 * Maintains per-agent conversation threads (in-memory).
 *
 * Part of Phase 5.0 (Pilot AGI-adl)
 */

const fs = require('fs');
const path = require('path');
const { PmKnowledgeBase } = require('./pm-knowledge-base');
const { PmIdentity } = require('./pm-identity');

// ============================================================================
// LAZY DEPS
// ============================================================================

let _pmDecisions = null;

function getPmDecisions() {
  if (!_pmDecisions) {
    try { _pmDecisions = require('./pm-decisions'); } catch (e) { _pmDecisions = null; }
  }
  return _pmDecisions;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TIMEOUT_MS = 120000;  // 2 min for complex decisions
const MAX_PROMPT_SIZE = 16000;      // 16KB cap
const MAX_THREAD_TURNS = 10;
const MAX_CALLS_PER_HOUR = 30;

// ============================================================================
// PM BRAIN
// ============================================================================

class PmBrain {
  /**
   * @param {string} projectRoot
   * @param {object} opts
   * @param {function} opts._callClaudeFn — injectable for testing
   * @param {number} opts.maxPromptSize
   * @param {number} opts.maxCallsPerHour
   * @param {number} opts.timeoutMs
   */
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.kb = new PmKnowledgeBase(projectRoot, opts);
    this.conversations = new Map(); // agentSessionId → [{role, content, ts}]

    this._callClaudeFn = opts._callClaudeFn || null;
    this.maxPromptSize = opts.maxPromptSize || MAX_PROMPT_SIZE;
    this.maxCallsPerHour = opts.maxCallsPerHour || MAX_CALLS_PER_HOUR;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    // Rate limiting
    this._callTimestamps = [];

    // M1.5 Sprint 3 — restore persisted conversation threads so PM
    // identity carries across daemon restarts. Failures are non-fatal:
    // a missing or malformed file just means we start with an empty
    // conversation state.
    if (opts.persistThreads !== false) {
      this._loadThreads();
    }

    // M1.5 Sprint 3 T2 — persistent PM identity log (decision counts,
    // decomposition history, recent prompts). Studio's PM Cockpit reads
    // this file directly; PmBrain only writes.
    if (opts.persistIdentity !== false) {
      this.identity = new PmIdentity(projectRoot, { sessionId: opts.sessionId });
    }
  }

  /**
   * Path on disk where conversation threads are persisted.
   */
  _threadsPath() {
    return path.join(
      this.projectRoot,
      '.claude/pilot/state/orchestrator/pm-threads.json'
    );
  }

  /**
   * Read pm-threads.json into `this.conversations`. Tolerates missing
   * file, malformed JSON, and unexpected shapes — caller should never
   * see a throw.
   */
  _loadThreads() {
    try {
      const raw = fs.readFileSync(this._threadsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.conversations) {
        for (const [sessionId, thread] of Object.entries(parsed.conversations)) {
          if (Array.isArray(thread)) {
            this.conversations.set(sessionId, thread.slice(-MAX_THREAD_TURNS));
          }
        }
      }
    } catch (e) {
      // ENOENT / SyntaxError / etc. — start clean.
    }
  }

  /**
   * Atomically write `this.conversations` to disk. Atomic = write to a
   * sibling tmp file, then rename. Best-effort; failures are swallowed
   * (the in-memory state remains correct, persistence just lags).
   */
  _saveThreads() {
    try {
      const filePath = this._threadsPath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const obj = {
        version: 1,
        updatedAt: new Date().toISOString(),
        conversations: Object.fromEntries(this.conversations.entries())
      };
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (e) {
      // Disk full / permission denied — leave in-memory state intact.
    }
  }

  /**
   * Ask the PM brain a question on behalf of an agent.
   *
   * @param {string} agentSessionId
   * @param {string} question
   * @param {object} context — { taskId, topic, agentName }
   * @returns {{ success: boolean, guidance?: string, decision?: object, error?: string }}
   */
  ask(agentSessionId, question, context = {}) {
    // Rate limit check
    if (!this._checkRateLimit()) {
      return {
        success: false,
        error: 'Rate limit exceeded — max ' + this.maxCallsPerHour + ' calls/hour'
      };
    }

    // 1. Gather knowledge
    const knowledge = this.kb.gather({
      agentId: agentSessionId,
      taskId: context.taskId,
      topic: context.topic
    });

    // 2. Get conversation history
    const thread = this.conversations.get(agentSessionId) || [];

    // 3. Build prompt
    const prompt = this._buildPrompt(knowledge, thread, question, context);

    // 4. Call claude -p
    let response;
    try {
      const callFn = this._callClaudeFn || this._defaultCallClaude.bind(this);
      response = callFn(prompt, {
        projectRoot: this.projectRoot,
        timeoutMs: this.timeoutMs
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    if (!response || !response.success) {
      return { success: false, error: response ? response.error : 'No response from claude' };
    }

    // 5. Store Q&A in thread
    thread.push({ role: 'agent', content: question, ts: Date.now() });
    thread.push({ role: 'pm', content: response.result, ts: Date.now() });
    this.conversations.set(agentSessionId, thread.slice(-MAX_THREAD_TURNS));
    this._saveThreads();

    // 6. Extract and persist decisions
    const result = response.result || {};
    if (result.decision) {
      this.kb.recordDecision({
        ...result.decision,
        agent: agentSessionId,
        task: context.taskId
      });
      // M1.5 Sprint 3 T2 — also bump the PM identity counters so the
      // cockpit reflects PM's evolving track record.
      if (this.identity && result.decision.type) {
        this.identity.recordDecision(result.decision.type);
      }
    }
    if (this.identity) {
      this.identity.recordPrompt(question);
    }

    // 7. Record call timestamp for rate limiting
    this._callTimestamps.push(Date.now());

    // R1 (2026-04-28) — single response envelope. Replaces the
    // || result.raw_text || JSON.stringify(result) fallback chain. The
    // mode dictates the expected shape; the normalizer enforces it.
    const mode = (context.audience === 'user' || context.audience === 'human')
      ? 'user' : 'agent';
    return this._normalizeResponse(result, mode);
  }

  /**
   * Coerce whatever the LLM returned into the canonical PM response
   * envelope. R1 of the architectural-debt audit (2026-04-28).
   *
   * Envelope:
   *   {
   *     success: true,
   *     mode: "user" | "agent",
   *     guidance: string,        // ALWAYS plain text the client can render
   *     decision: { type, action?, reason? } | null,
   *     subtasks: [{ title, role? }] | null,
   *     follow_up: string | null
   *   }
   *
   * User mode: LLM should return plain text. If it ignored that and
   * wrapped in JSON anyway, we unwrap once.
   * Agent mode: LLM should return JSON. We accept the structured fields,
   * fall back to stringification only as a last resort with a flag.
   */
  _normalizeResponse(result, mode) {
    // Plain string from claude — common in user mode.
    if (typeof result === 'string') {
      return {
        success: true, mode,
        guidance: result.trim(),
        decision: null, subtasks: null, follow_up: null
      };
    }
    if (!result || typeof result !== 'object') {
      return {
        success: true, mode,
        guidance: '', decision: null, subtasks: null, follow_up: null
      };
    }

    // Some claude versions wrap their plain reply in {"raw_text": "..."}.
    // Unwrap once so user-mode clients see clean text.
    let guidance = result.guidance;
    if (!guidance && typeof result.raw_text === 'string') {
      guidance = result.raw_text;
    }
    if (!guidance && typeof result.reply === 'string') {
      guidance = result.reply;
    }
    if (!guidance) {
      // Last resort. Don't dump JSON onto user-mode chats.
      guidance = mode === 'user' ? '' : JSON.stringify(result);
    }
    guidance = String(guidance).trim();

    return {
      success: true,
      mode,
      guidance,
      decision: result.decision || null,
      subtasks: Array.isArray(result.subtasks) ? result.subtasks : null,
      follow_up: result.follow_up || null
    };
  }

  /**
   * Get conversation thread for an agent.
   */
  getThread(agentSessionId) {
    return this.conversations.get(agentSessionId) || [];
  }

  /**
   * Clear conversation thread for an agent. Persists.
   */
  clearThread(agentSessionId) {
    this.conversations.delete(agentSessionId);
    this._saveThreads();
  }

  /**
   * Clear all threads (e.g. on daemon restart). Persists.
   */
  clearAllThreads() {
    this.conversations.clear();
    this._saveThreads();
  }

  // ==========================================================================
  // PROMPT BUILDER
  // ==========================================================================

  /**
   * R1 (2026-04-28) — entry point keeps its existing signature for
   * backward compatibility, but routes to one of two cleanly-separated
   * builders. Each is responsible for its own scaffolding; nothing is
   * shared except `knowledge`. Adding a third audience later (e.g.
   * "supervisor", "auditor") is a new builder, not a third branch in
   * an if-else.
   */
  _buildPrompt(knowledge, thread, question, context) {
    const audience = context.audience === 'user' || context.audience === 'human'
      ? 'user' : 'agent';
    return audience === 'user'
      ? this._buildUserPrompt(knowledge, question)
      : this._buildAgentPrompt(knowledge, thread, question, context);
  }

  /**
   * User-mode prompt. Minimal scaffolding — the LLM sees ONLY persona
   * + question. No productBrief, no project-state matrix, no agent
   * registry, no decisions log. Those sections are routing memory
   * meant for backend agents and they poison user-mode chats by
   * triggering deregistration / contract language.
   *
   * R1 of architectural-debt audit (2026-04-28).
   */
  _buildUserPrompt(knowledge, question) {
    const proactiveHints = `## Pilot AGI quick reference\n` +
      `If it would help the user, you can suggest these commands by name:\n` +
      `- /pilot-init — initialize a project (creates work/PROJECT_BRIEF.md + ROADMAP.md)\n` +
      `- /pilot-sprint — plan a new sprint of bd tasks\n` +
      `- /pilot-plan — write an implementation plan for the current task\n` +
      `- /pilot-exec — execute one approved plan step\n` +
      `- /pilot-commit — commit current work\n` +
      `- /pilot-review — review the diff\n` +
      `- /pilot-close — close the current bd task\n` +
      `- /pilot-next — pick the top ready task\n` +
      `bd is the source of truth for tasks. \`bd ready\` shows what's actionable.`;

    return [
      `# You are the PM for the project "${knowledge.projectName}"`,
      ``,
      `You are a friendly, proactive senior product manager chatting directly with the founder/operator (a HUMAN). Be warm, concise, opinionated. Match energy: greetings get one-sentence replies; real questions get 1-3 short paragraphs.`,
      ``,
      `**Output format:** plain text only. No JSON. No code-block wrappers. No "raw_text" key. Just write the reply as if texting a colleague.`,
      ``,
      `**You cannot execute commands yourself.** You are advisory. Tell the user the command to run; do not offer to run it. "Run \`/pilot-next\` to grab the top task" — not "want me to run /pilot-next?".`,
      ``,
      `**Be proactive but decisive.** When the user is vague ("hi", "what now"), pick the single most useful next command and recommend it. Don't list 3 options. The user can push back if they want something else.`,
      ``,
      `**Don't lecture.** Skip "non-compliant pings", "deregistered agents", "contracts", "canonical loop violations". The user is a person, not a backend agent.`,
      ``,
      proactiveHints,
      ``,
      `## User's Message`,
      question,
      ``,
      `## Your Reply (plain text)`,
      ``
    ].join('\n');
  }

  /**
   * Agent-mode prompt. Full project context (productBrief, project
   * state, recent decisions, agent registry, task graph), structured
   * JSON output enforced, conversation thread included for continuity.
   *
   * R1 of architectural-debt audit (2026-04-28). The fitToLimit logic
   * is preserved — only the layered priority sections moved here.
   */
  _buildAgentPrompt(knowledge, thread, question, context) {
    const sections = [];
    const inProgress = Array.isArray(knowledge.tasksInProgress) ? knowledge.tasksInProgress : [];
    const blocked = Array.isArray(knowledge.tasksBlocked) ? knowledge.tasksBlocked : [];
    const agents = Array.isArray(knowledge.activeAgents) ? knowledge.activeAgents : [];

    sections.push({
      priority: 0,
      content: `## Agent's Question\nAgent ${context.agentName || context.agentId || 'unknown'} (working on ${context.taskId || 'unknown'}):\n\n${question}\n\n## Your Response\nRespond as the PM. Be specific, actionable, and authoritative. Return JSON matching this exact shape:\n{\n  "guidance": "human-readable response",\n  "decision": { "type": "decompose|answer|defer|hold", "action": "...", "reason": "..." },\n  "subtasks": [{ "title": "...", "role": "..." }],\n  "follow_up": "optional question back to the agent"\n}\n"subtasks" is required ONLY when decision.type=="decompose"; otherwise omit or set null. "follow_up" is optional everywhere.`
    });

    sections.push({
      priority: 1,
      content: `# You are the PM Agent for "${knowledge.projectName}"\n\n${knowledge.productBrief}\n\n## Your Role\nYou are the Project Manager. You make decisions about task prioritization, code review, architecture guidance, conflict resolution, agent coordination, and risk assessment.\nYou have full knowledge of the project state. Respond with actionable guidance.`
    });

    sections.push({
      priority: 2,
      content: `## Current Project State\n- Milestone: ${knowledge.currentMilestone || 'Unknown'}\n- Phase: ${knowledge.currentPhase || 'Unknown'}\n- Active Agents: ${agents.length}\n- Tasks In Progress: ${inProgress.map(t => `${t.id}: ${t.title || t.summary || ''}`).join(', ') || 'none'}\n- Tasks Blocked: ${blocked.length}\n- Budget Used: ${knowledge.budgetUsedToday || 'N/A'}`
    });

    const decisions = Array.isArray(knowledge.recentDecisions) ? knowledge.recentDecisions : [];
    if (decisions.length > 0) {
      sections.push({
        priority: 3,
        content: `## Recent PM Decisions\n${decisions.map(d => `- [${d.ts}] ${d.type}: ${d.summary || d.action || ''} (outcome: ${d.outcome || 'pending'})`).join('\n')}`
      });
    }
    if (agents.length > 0) {
      sections.push({
        priority: 4,
        content: `## Active Agent States\n${agents.map(a => `- ${a.agent_name || a.session_id} (${a.role || 'general'}): task=${a.claimed_task || 'idle'}, pressure=${a.pressure || 'unknown'}`).join('\n')}`
      });
    }
    if (knowledge.taskSummary) {
      sections.push({
        priority: 5,
        content: `## Task Graph\n${knowledge.taskSummary}`
      });
    }
    return this._appendAgentTail(sections, knowledge, thread);
  }

  /** Tail sections shared by agent mode (research, agent plan, thread). */
  _appendAgentTail(sections, knowledge, thread) {

    // Priority 6: Research
    if (knowledge.relevantResearch) {
      sections.push({
        priority: 6,
        content: `## Relevant Research\n${knowledge.relevantResearch}`
      });
    }

    // Priority 7: Agent's plan
    if (knowledge.agentPlan) {
      sections.push({
        priority: 7,
        content: `## Agent's Current Plan\n${knowledge.agentPlan}`
      });
    }

    // Priority 8: Conversation thread
    if (thread.length > 0) {
      sections.push({
        priority: 8,
        content: `## Previous Conversation with This Agent\n${thread.map(t => `${t.role.toUpperCase()}: ${typeof t.content === 'string' ? t.content : JSON.stringify(t.content)}`).join('\n\n')}`
      });
    }

    return this._fitToLimit(sections);
  }

  _fitToLimit(sections) {
    sections.sort((a, b) => a.priority - b.priority);
    let result = '';
    for (const section of sections) {
      if ((result + '\n\n' + section.content).length > this.maxPromptSize) {
        const remaining = this.maxPromptSize - result.length - 100;
        if (remaining > 200) {
          result += '\n\n' + section.content.substring(0, remaining) + '\n[...truncated]';
        }
        break;
      }
      result += (result ? '\n\n' : '') + section.content;
    }
    return result;
  }

  // ==========================================================================
  // RATE LIMITING
  // ==========================================================================

  _checkRateLimit() {
    const oneHourAgo = Date.now() - 3600000;
    this._callTimestamps = this._callTimestamps.filter(ts => ts > oneHourAgo);
    return this._callTimestamps.length < this.maxCallsPerHour;
  }

  // ==========================================================================
  // DEFAULT CLAUDE CALL
  // ==========================================================================

  _defaultCallClaude(prompt, opts) {
    const pmDec = getPmDecisions();
    if (pmDec && typeof pmDec.callClaude === 'function') {
      return pmDec.callClaude(prompt, opts);
    }
    // Fallback: direct execFileSync
    const { execFileSync } = require('child_process');
    const output = execFileSync('claude', ['-p', prompt, '--output-format', 'json'], {
      cwd: opts.projectRoot || this.projectRoot,
      encoding: 'utf8',
      timeout: opts.timeoutMs || this.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PILOT_DAEMON_SPAWNED: '1' }
    });
    try {
      const envelope = JSON.parse(output);
      const text = envelope.result || envelope.content || envelope.text || output;
      const parsed = typeof text === 'string' ? JSON.parse(text) : text;
      return { success: true, result: parsed };
    } catch (e) {
      return { success: true, result: { raw_text: output } };
    }
  }
}

module.exports = { PmBrain };
