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

    return {
      success: true,
      guidance: result.guidance
        || result.raw_text
        || (typeof result === 'string' ? result : JSON.stringify(result)),
      decision: result.decision || null,
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

  _buildPrompt(knowledge, thread, question, context) {
    const sections = [];
    // M1.5 Sprint 5 — branch on audience. The PM responds very differently
    // to a human user typing in a chat ("hi", "what should I work on?") vs
    // a backend agent requesting a structured decomposition decision.
    const isUser = context.audience === 'user' || context.audience === 'human';

    if (isUser) {
      // Conversational mode — minimal scaffolding. Loading the
      // productBrief or project-state sections poisons the response
      // with contract language. For human chat, give the LLM ONLY
      // persona + the user's message. Critically, instruct the LLM
      // to RETURN PLAIN TEXT (not JSON, not markdown code blocks) so
      // Studio renders it directly without unwrapping.
      const proactiveHints = `## Pilot AGI quick reference\nIf it would help the user, you can suggest these commands by name:\n- /pilot-init — initialize a project (creates work/PROJECT_BRIEF.md + ROADMAP.md)\n- /pilot-sprint — plan a new sprint of bd tasks\n- /pilot-plan — write an implementation plan for the current task\n- /pilot-exec — execute one approved plan step\n- /pilot-commit — commit current work\n- /pilot-review — review the diff\n- /pilot-close — close the current bd task\n- /pilot-next — pick the top ready task\nbd is the source of truth for tasks. \`bd ready\` shows what's actionable. Suggest the next concrete step in the canonical loop when the user is ambiguous about what to do.`;
      sections.push({
        priority: 0,
        content: `# You are the PM for the project "${knowledge.projectName}"\n\n` +
          `You are a friendly, proactive senior product manager chatting directly with the founder/operator (a HUMAN). Be warm, concise, opinionated. Match energy: greetings get one-sentence replies; real questions get 1-3 short paragraphs.\n\n` +
          `**Output format:** plain text only. No JSON. No code-block wrappers. No "raw_text" key. Just write the reply as if texting a colleague.\n\n` +
          `**You cannot execute commands yourself.** You are advisory. NEVER say "want me to run /pilot-next?" or "I'll grab the top task" — you can't. Instead, TELL THE USER WHAT TO DO: "Run \`/pilot-next\` to grab the top task" or "Try \`bd ready\` to see what's actionable." Frame as direct instructions, not offers.\n\n` +
          `**Be proactive but decisive.** When the user is vague ("hi", "what now", "where are we"), pick the single most useful next command and tell them to run it. Don't list 3 options every time. Don't ask "or X or Y?". Pick one and recommend it. The user can push back if they want something else.\n\n` +
          `**No loops.** If you've already recommended /pilot-next twice and the user keeps saying "yes", they probably already ran it — ask what they're seeing instead of repeating yourself.\n\n` +
          `**Don't lecture.** No talk about "non-compliant pings", "deregistered agents", "contracts", or "canonical loop violations". The user is a person, not a backend agent.\n\n` +
          `${proactiveHints}\n\n` +
          `## User's Message\n${question}\n\n## Your Reply (plain text)\n`
      });
      // No other priorities for user mode — return early.
      return this._fitToLimit(sections);
    }

    // ------ Agent mode (existing): structured JSON decision ------
    sections.push({
      priority: 0,
      content: `## Agent's Question\nAgent ${context.agentName || context.agentId || 'unknown'} (working on ${context.taskId || 'unknown'}):\n\n${question}\n\n## Your Response\nRespond as the PM. Be specific, actionable, and authoritative. Return JSON:\n{\n  "guidance": "your detailed response",\n  "decision": { "type": "...", "action": "...", "reason": "..." },\n  "follow_up": "any question back to the agent (optional)"\n}`
    });

    // Priority 1: PM persona + product brief (agent mode only)
    sections.push({
      priority: 1,
      content: `# You are the PM Agent for "${knowledge.projectName}"\n\n${knowledge.productBrief}\n\n## Your Role\nYou are the Project Manager. You make decisions about task prioritization, code review, architecture guidance, conflict resolution, agent coordination, and risk assessment.\nYou have full knowledge of the project state. Respond with actionable guidance.`
    });

    // Priority 2: Project state
    const inProgress = Array.isArray(knowledge.tasksInProgress) ? knowledge.tasksInProgress : [];
    const blocked = Array.isArray(knowledge.tasksBlocked) ? knowledge.tasksBlocked : [];
    const agents = Array.isArray(knowledge.activeAgents) ? knowledge.activeAgents : [];
    sections.push({
      priority: 2,
      content: `## Current Project State\n- Milestone: ${knowledge.currentMilestone || 'Unknown'}\n- Phase: ${knowledge.currentPhase || 'Unknown'}\n- Active Agents: ${agents.length}\n- Tasks In Progress: ${inProgress.map(t => `${t.id}: ${t.title || t.summary || ''}`).join(', ') || 'none'}\n- Tasks Blocked: ${blocked.length}\n- Budget Used: ${knowledge.budgetUsedToday || 'N/A'}`
    });

    // Priorities 3-5 (recent decisions, agent states, task graph) are
    // routing/orchestration memory aimed at backend agents. Including
    // them in user-mode poisons the conversation: a single prior
    // 'drop-message' decision in the channel makes the LLM treat the
    // human user as the deregistered agent. Skip them for user mode.
    if (!isUser) {
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
    }

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
