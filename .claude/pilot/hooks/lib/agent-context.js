/**
 * Agent Working Context — Shared Status Board & Collaboration
 *
 * Enables agents to see each other's progress on active tasks.
 * Publishes task status, files being modified, and progress updates
 * to a shared memory channel that all agents can read.
 * Provides context injection, delegation tracking, escalation,
 * and service discovery.
 *
 * Part of Phase 3.9 — Agent-to-Agent Collaboration (Pilot AGI-fjd)
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const session = require('./session');

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTEXT_CHANNEL = 'working-context';
const HUMAN_ESCALATION_PATH = '.claude/pilot/state/human-escalations.jsonl';
const CONTEXT_SCHEMA = {
  type: 'object',
  required: ['agents'],
  properties: {
    agents: { type: 'object' }
  }
};

function getHumanEscalationPath() {
  return path.join(process.cwd(), HUMAN_ESCALATION_PATH);
}

// ============================================================================
// CHANNEL INITIALIZATION
// ============================================================================

/**
 * Ensure the working-context memory channel exists.
 */
function ensureChannel() {
  // Check if channel file exists directly (index.json may not track dynamic channels)
  const channelPath = path.join(process.cwd(), '.claude/pilot/memory/channels', `${CONTEXT_CHANNEL}.json`);
  if (!fs.existsSync(channelPath)) {
    memory.publish(CONTEXT_CHANNEL, { agents: {} }, {
      agent: 'agent-context',
      summary: 'Shared working context for agent collaboration'
    });
  }
}

// ============================================================================
// PUBLISH PROGRESS
// ============================================================================

/**
 * Publish an agent's current working status to the shared context.
 *
 * @param {string} sessionId - Agent's session ID
 * @param {object} status - { taskId, taskTitle, step, totalSteps, filesModified, status }
 */
function publishProgress(sessionId, status) {
  ensureChannel();

  const existing = memory.read(CONTEXT_CHANNEL);
  const data = existing ? existing.data : { agents: {} };

  // Read session state for agent identity
  let agentName = sessionId;
  let role = null;
  try {
    const sessDir = path.join(process.cwd(), '.claude/pilot/state/sessions');
    const sessFile = path.join(sessDir, `${sessionId}.json`);
    if (fs.existsSync(sessFile)) {
      const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      agentName = sess.agent_name || sessionId;
      role = sess.role || null;
    }
  } catch (e) {
    // Use defaults
  }

  data.agents[sessionId] = {
    agent_name: agentName,
    role,
    task_id: status.taskId || null,
    task_title: status.taskTitle || null,
    step: status.step || null,
    total_steps: status.totalSteps || null,
    files_modified: (status.filesModified || []).slice(0, 20),
    status: status.status || 'working',
    updated_at: new Date().toISOString()
  };

  memory.publish(CONTEXT_CHANNEL, data, {
    agent: sessionId,
    summary: `${agentName}: ${status.status || 'working'} on ${status.taskId || 'unknown'}`
  });
}

/**
 * Remove an agent's entry from the shared context (on session end).
 *
 * @param {string} sessionId
 */
function removeAgent(sessionId) {
  ensureChannel();

  const existing = memory.read(CONTEXT_CHANNEL);
  if (!existing || !existing.data || !existing.data.agents) return;

  const data = existing.data;
  delete data.agents[sessionId];

  memory.publish(CONTEXT_CHANNEL, data, {
    agent: sessionId,
    summary: `Agent ${sessionId} removed from working context`
  });
}

// ============================================================================
// READ CONTEXT
// ============================================================================

/**
 * Get the full shared working context — all agents' status.
 *
 * @returns {object} Map of sessionId → agent status
 */
function getWorkingContext() {
  ensureChannel();

  const existing = memory.read(CONTEXT_CHANNEL);
  if (!existing || !existing.data) return {};

  return existing.data.agents || {};
}

/**
 * Get progress for agents working on tasks related to a given task.
 * "Related" means: same files modified, or tasks that block/are blocked by this one.
 *
 * @param {string} taskId - The task to find related work for
 * @returns {object[]} Array of related agent status entries
 */
function getRelatedProgress(taskId) {
  const context = getWorkingContext();
  const related = [];

  for (const [sid, entry] of Object.entries(context)) {
    if (entry.task_id === taskId) {
      related.push({ ...entry, session_id: sid, relation: 'same_task' });
    }
  }

  return related;
}

/**
 * Get agents working on specific files (potential conflict detection).
 *
 * @param {string[]} files - Files to check
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {object[]} Agents working on overlapping files
 */
function getAgentsOnFiles(files, excludeSessionId = null) {
  const context = getWorkingContext();
  const fileSet = new Set(files);
  const overlapping = [];

  for (const [sid, entry] of Object.entries(context)) {
    if (excludeSessionId && sid === excludeSessionId) continue;
    if (!entry.files_modified || entry.files_modified.length === 0) continue;

    const overlap = entry.files_modified.filter(f => fileSet.has(f));
    if (overlap.length > 0) {
      overlapping.push({
        ...entry,
        session_id: sid,
        overlapping_files: overlap
      });
    }
  }

  return overlapping;
}

// ============================================================================
// SERVICE DISCOVERY
// ============================================================================

/**
 * Discover agents by capability (searches agent registry + active sessions).
 *
 * @param {string} capability - Capability to search for (e.g., 'react', 'api-design')
 * @returns {object[]} Active agents with the requested capability
 */
function discoverAgentByCap(capability) {
  const registry = session.loadAgentRegistry();
  if (!registry || !registry.agents) return [];

  // Find roles that have this capability
  const matchingRoles = [];
  for (const [role, config] of Object.entries(registry.agents)) {
    const caps = config.capabilities || [];
    if (caps.includes(capability)) {
      matchingRoles.push(role);
    }
  }

  if (matchingRoles.length === 0) return [];

  // Find active sessions with matching roles
  const activeSessions = session.getActiveSessions();
  return activeSessions
    .filter(s => s.role && matchingRoles.includes(s.role))
    .map(s => ({
      session_id: s.session_id,
      agent_name: s.agent_name,
      role: s.role,
      claimed_task: s.claimed_task,
      capabilities: session.getAgentCapabilities(s.role)
    }));
}

/**
 * Get a status board summary — compact view of all agent activity.
 *
 * @returns {object} { agents: [...], total, working, idle }
 */
function getStatusBoard() {
  const context = getWorkingContext();
  const entries = Object.entries(context).map(([sid, entry]) => ({
    session_id: sid,
    ...entry
  }));

  const working = entries.filter(e => e.status === 'working');
  const idle = entries.filter(e => e.status === 'idle');

  return {
    agents: entries,
    total: entries.length,
    working: working.length,
    idle: idle.length
  };
}

// ============================================================================
// AGENT CONTEXT (Full Context for a Specific Agent)
// ============================================================================

/**
 * Get full working context for a specific agent.
 * Includes status + recent decisions + recent discoveries from memory.
 *
 * @param {string} sessionId - Target session ID
 * @returns {object|null} Agent context with decisions and discoveries, or null
 */
function getAgentContext(sessionId) {
  const context = getWorkingContext();
  const status = context[sessionId];
  if (!status) return null;

  let decisions = [];
  let discoveries = [];
  if (status.role) {
    try {
      decisions = memory.getDecisions(status.role, { limit: 5 });
      discoveries = memory.getDiscoveries(status.role).slice(-5);
    } catch (e) {
      // Memory module may not have data for this agent
    }
  }

  return {
    session_id: sessionId,
    ...status,
    recent_decisions: decisions,
    recent_discoveries: discoveries
  };
}

// ============================================================================
// SHARED CONTEXT INJECTION
// ============================================================================

/**
 * Get related context for a message or task.
 * Finds peer decisions on overlapping files, related tasks, and channel data.
 *
 * @param {object} messageOrTask
 * @param {string} [messageOrTask.topic] - Message topic
 * @param {string[]} [messageOrTask.files] - Related files
 * @param {string} [messageOrTask.from] - Sender session ID
 * @returns {{ peer_decisions: object[], related_tasks: object[], channel_data: object }}
 */
function getRelatedContext(messageOrTask) {
  const result = {
    peer_decisions: [],
    related_tasks: [],
    channel_data: {}
  };

  // 1. Find peer decisions on related files
  if (messageOrTask.files && messageOrTask.files.length > 0) {
    try {
      const agentTypes = memory.listAgentTypes();
      for (const agentType of agentTypes) {
        const decisions = memory.getDecisions(agentType, { limit: 10 });
        for (const d of decisions) {
          if (d.files && d.files.some(f => messageOrTask.files.includes(f))) {
            result.peer_decisions.push({ agent: agentType, ...d });
          }
        }
      }
    } catch (e) {
      // Best effort
    }
  }

  // 2. Find related tasks from working context
  const board = getWorkingContext();
  for (const [sid, agent] of Object.entries(board)) {
    if (sid === messageOrTask.from) continue;
    if (!agent.files_modified || agent.files_modified.length === 0) continue;

    if (messageOrTask.files && messageOrTask.files.length > 0) {
      const overlap = agent.files_modified.filter(f =>
        messageOrTask.files.some(mf => f.includes(mf) || mf.includes(f))
      );
      if (overlap.length > 0) {
        result.related_tasks.push({
          session_id: sid,
          role: agent.role,
          agent_name: agent.agent_name,
          task_id: agent.task_id,
          task_title: agent.task_title,
          overlapping_files: overlap
        });
      }
    }
  }

  // 3. Get relevant channel data based on topic
  if (messageOrTask.topic) {
    try {
      const channels = memory.listChannels();
      const topicRoot = messageOrTask.topic.split('.')[0];
      for (const ch of channels) {
        if (messageOrTask.topic.includes(ch) || ch.includes(topicRoot)) {
          const data = memory.readSummary(ch);
          if (data) {
            result.channel_data[ch] = data;
          }
        }
      }
    } catch (e) {
      // Best effort
    }
  }

  return result;
}

/**
 * Enrich incoming messages with peer context.
 * Attaches _context field to each message with related info.
 *
 * @param {string} sessionId - Reading session (unused, for future filtering)
 * @param {object[]} messages - Messages from readMessages()
 * @returns {object[]} Messages with _context attached where relevant
 */
function injectContext(sessionId, messages) {
  return messages.map(msg => {
    const files = [];
    if (msg.payload && msg.payload.data) {
      if (msg.payload.data.files) files.push(...msg.payload.data.files);
      if (msg.payload.data.file) files.push(msg.payload.data.file);
    }

    const context = getRelatedContext({
      topic: msg.topic,
      files,
      from: msg.from
    });

    const hasContext = context.peer_decisions.length > 0 ||
      context.related_tasks.length > 0 ||
      Object.keys(context.channel_data).length > 0;

    return hasContext ? { ...msg, _context: context } : msg;
  });
}

// ============================================================================
// DELEGATED TASKS
// ============================================================================

/**
 * Get tasks delegated by or to a session.
 * Scans the message bus for task_delegate messages.
 *
 * @param {string} sessionId - Agent session ID
 * @param {string} [direction] - 'from', 'to', or 'both' (default)
 * @returns {object[]} Delegation records
 */
function getDelegatedTasks(sessionId, direction = 'both') {
  const results = [];
  const busPath = path.join(process.cwd(), '.claude/pilot/messages/bus.jsonl');
  if (!fs.existsSync(busPath)) return results;

  try {
    const lines = fs.readFileSync(busPath, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'task_delegate') continue;

        const isFrom = msg.from === sessionId;
        const isTo = msg.to === sessionId || msg.to_agent === sessionId;

        if (direction === 'from' && isFrom) results.push(msg);
        else if (direction === 'to' && isTo) results.push(msg);
        else if (direction === 'both' && (isFrom || isTo)) results.push(msg);
      } catch (e) { /* skip malformed */ }
    }
  } catch (e) { /* best effort */ }

  return results;
}

// ============================================================================
// HUMAN ESCALATION
// ============================================================================

/**
 * Record a human escalation (when all automated escalation levels fail).
 *
 * @param {object} entry - { from, reason, original_message_id, context }
 * @returns {object} The recorded escalation entry
 */
function recordHumanEscalation(entry) {
  const escalationPath = getHumanEscalationPath();
  const dir = path.dirname(escalationPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const record = {
    ts: new Date().toISOString(),
    resolved: false,
    ...entry
  };

  fs.appendFileSync(escalationPath, JSON.stringify(record) + '\n');
  return record;
}

/**
 * Get pending human escalations (unresolved).
 *
 * @returns {object[]} Unresolved escalations
 */
function getPendingHumanEscalations() {
  const escalationPath = getHumanEscalationPath();
  if (!fs.existsSync(escalationPath)) return [];

  try {
    const lines = fs.readFileSync(escalationPath, 'utf8').split('\n').filter(l => l.trim());
    return lines
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(e => e && !e.resolved);
  } catch (e) {
    return [];
  }
}

// ============================================================================
// SERVICE DISCOVERY — by file pattern
// ============================================================================

/**
 * Find the best-matching agent for a given file path.
 * Uses agent-registry.json file_patterns with glob-like matching.
 *
 * @param {string} filePath - File path to match
 * @param {string} [excludeSessionId] - Session to exclude
 * @returns {object|null} Best matching agent or null
 */
function discoverAgentByFile(filePath, excludeSessionId) {
  const registry = session.loadAgentRegistry();
  if (!registry || !registry.agents) return null;

  let bestRole = null;
  let bestScore = 0;

  for (const [role, config] of Object.entries(registry.agents)) {
    const patterns = config.file_patterns || [];
    const excluded = config.excluded_patterns || [];

    const isExcluded = excluded.some(p => simpleGlobMatch(filePath, p));
    if (isExcluded) continue;

    for (const pattern of patterns) {
      if (simpleGlobMatch(filePath, pattern)) {
        const score = patternSpecificity(pattern);
        if (score > bestScore) {
          bestScore = score;
          bestRole = role;
        }
      }
    }
  }

  if (!bestRole) return null;

  const activeSessions = session.getActiveSessions(excludeSessionId);
  const match = activeSessions.find(s => s.role === bestRole);

  if (!match) {
    return { role: bestRole, session_id: null, agent_name: null, active: false };
  }

  return {
    session_id: match.session_id,
    agent_name: match.agent_name,
    role: bestRole,
    capabilities: session.getAgentCapabilities(bestRole),
    active: true
  };
}

/**
 * Simple glob matcher for ** and * patterns.
 * Escapes dots first, then replaces glob patterns with regex equivalents.
 */
function simpleGlobMatch(filePath, pattern) {
  // Escape dots before replacing glob patterns to avoid double-escaping
  let regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*');

  try {
    return new RegExp(`^${regex}$`).test(filePath) ||
      new RegExp(regex).test(filePath);
  } catch (e) {
    return false;
  }
}

/**
 * Calculate pattern specificity — more specific patterns score higher.
 */
function patternSpecificity(pattern) {
  let score = 1;
  const parts = pattern.split('/');
  for (const part of parts) {
    if (part !== '**' && part !== '*') score += 2;
    if (part.includes('.')) score += 1;
  }
  return score;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  CONTEXT_CHANNEL,
  HUMAN_ESCALATION_PATH,
  // Channel
  ensureChannel,
  // Status publishing
  publishProgress,
  removeAgent,
  // Status reading
  getWorkingContext,
  getRelatedProgress,
  getAgentsOnFiles,
  getAgentContext,
  getStatusBoard,
  // Context injection
  getRelatedContext,
  injectContext,
  // Delegated tasks
  getDelegatedTasks,
  // Service discovery
  discoverAgentByCap,
  discoverAgentByFile,
  // Human escalation
  recordHumanEscalation,
  getPendingHumanEscalations
};
