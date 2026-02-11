/**
 * Spawn Context Builder (Phase 4.2)
 *
 * Builds structured context capsules for agent spawning.
 * Gathers task metadata, research, checkpoint, approved plan,
 * and related agent status into a single package that gets
 * injected into the agent's initial prompt.
 *
 * Used by process-spawner.js to pre-load agents with full
 * situational awareness instead of minimal task ID only.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// LAZY DEPENDENCIES (avoid circular requires)
// ============================================================================

let _checkpoint = null;
let _memory = null;
let _pmResearch = null;
let _agentContext = null;
let _recovery = null;
let _artifactRegistry = null;

function getCheckpoint() {
  if (!_checkpoint) _checkpoint = require('./checkpoint');
  return _checkpoint;
}

function getMemory() {
  if (!_memory) {
    try { _memory = require('./memory'); } catch (e) { _memory = null; }
  }
  return _memory;
}

function getPmResearch() {
  if (!_pmResearch) {
    try { _pmResearch = require('./pm-research'); } catch (e) { _pmResearch = null; }
  }
  return _pmResearch;
}

function getAgentContext() {
  if (!_agentContext) {
    try { _agentContext = require('./agent-context'); } catch (e) { _agentContext = null; }
  }
  return _agentContext;
}

function getArtifactRegistry() {
  if (!_artifactRegistry) {
    try { _artifactRegistry = require('./artifact-registry'); } catch (e) { _artifactRegistry = null; }
  }
  return _artifactRegistry;
}

function getRecovery() {
  if (!_recovery) {
    try { _recovery = require('./recovery'); } catch (e) { _recovery = null; }
  }
  return _recovery;
}

// ============================================================================
// CONTEXT CAPSULE BUILDER
// ============================================================================

/**
 * Build a structured context capsule for spawning an agent.
 *
 * @param {object} task - Task object { id, title, description, labels }
 * @param {object} options
 * @param {string} options.projectRoot - Project root path
 * @param {string} [options.previousSessionId] - Session ID of crashed/ended agent (for resume)
 * @param {string} [options.agentType] - Resolved agent type (frontend, backend, etc.)
 * @returns {object} Context capsule
 */
function buildContextCapsule(task, options = {}) {
  const { projectRoot, previousSessionId, agentType } = options;

  const capsule = {
    task: {
      id: task.id,
      title: task.title || '',
      description: task.description || null,
      labels: task.labels || []
    },
    resume: null,
    research: null,
    plan: null,
    related_decisions: [],
    related_agents: [],
    artifacts: [],
    agent_type: agentType || null
  };

  // 1. Check for resume context (checkpoint from previous session)
  if (previousSessionId) {
    capsule.resume = _buildResumeContext(previousSessionId);
  }

  // 2. Gather research context
  capsule.research = _gatherResearch(task.id, projectRoot);

  // 3. Load approved plan if one exists
  capsule.plan = _loadExistingPlan(task.id, projectRoot);

  // 4. Get related PM decisions
  capsule.related_decisions = _gatherDecisions(task);

  // 5. Get related agent working context
  capsule.related_agents = _gatherRelatedAgents(task.id);

  // 6. Gather available artifact inputs from dependencies (Phase 4.7)
  capsule.artifacts = _gatherArtifacts(task.id, projectRoot);

  return capsule;
}

/**
 * Build resume context from a previous session's checkpoint.
 *
 * @param {string} sessionId - Previous session ID
 * @returns {object|null} Resume context
 */
function _buildResumeContext(sessionId) {
  const cp = getCheckpoint();
  if (!cp) return null;

  const checkpoint = cp.loadCheckpoint(sessionId);
  if (!checkpoint) return null;

  return {
    from_session: sessionId,
    checkpoint,
    restoration_prompt: cp.buildRestorationPrompt(checkpoint)
  };
}

/**
 * Gather research context for a task.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {object|null}
 */
function _gatherResearch(taskId, projectRoot) {
  const pmResearch = getPmResearch();
  if (!pmResearch) return null;

  try {
    return pmResearch.buildResearchContext(taskId);
  } catch (e) {
    return null;
  }
}

/**
 * Load an existing approved plan for a task.
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {object|null}
 */
function _loadExistingPlan(taskId, projectRoot) {
  const root = projectRoot || process.cwd();

  // Check approved-plans state
  const approvalPath = path.join(root, '.claude/pilot/state/approved-plans', taskId + '.json');
  if (!fs.existsSync(approvalPath)) return null;

  try {
    const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));

    // Look for the plan file itself in work/plans/
    const planDir = path.join(root, 'work/plans');
    if (fs.existsSync(planDir)) {
      const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const planFiles = fs.readdirSync(planDir).filter(f =>
        f.includes(safeId) && f.endsWith('.md')
      );
      if (planFiles.length > 0) {
        const planContent = fs.readFileSync(
          path.join(planDir, planFiles[0]), 'utf8'
        );
        return {
          approved_at: approval.approved_at,
          auto_approved: approval.auto_approved || false,
          steps: approval.steps || null,
          content: planContent.slice(0, 4000) // Cap at 4KB to save context
        };
      }
    }

    // Return approval metadata even without plan file
    return {
      approved_at: approval.approved_at,
      auto_approved: approval.auto_approved || false,
      steps: approval.steps || null,
      content: null
    };
  } catch (e) {
    return null;
  }
}

/**
 * Gather PM decisions related to this task.
 *
 * @param {object} task - Task object
 * @returns {Array}
 */
function _gatherDecisions(task) {
  const mem = getMemory();
  if (!mem) return [];

  try {
    const decisions = mem.read('pm-decisions');
    if (!decisions || !decisions.entries) return [];

    return decisions.entries
      .filter(e =>
        e.task_id === task.id ||
        (task.labels || []).some(l => (e.labels || []).includes(l))
      )
      .slice(-5); // Last 5 relevant decisions
  } catch (e) {
    return [];
  }
}

/**
 * Gather working context from related agents.
 *
 * @param {string} taskId
 * @returns {Array}
 */
function _gatherRelatedAgents(taskId) {
  const ac = getAgentContext();
  if (!ac) return [];

  try {
    const board = ac.getBoard();
    if (!board || !board.agents) return [];

    // Return all active agents' published context (compact form)
    return Object.entries(board.agents)
      .filter(([, a]) => a.status === 'active')
      .map(([id, a]) => ({
        session_id: id,
        task: a.current_task || null,
        status: a.status_message || null
      }))
      .slice(0, 5); // Cap at 5 to save tokens
  } catch (e) {
    return [];
  }
}

// ============================================================================
// PROMPT GENERATION
// ============================================================================

/**
 * Generate the spawn prompt from a context capsule.
 * This is what gets passed as `-p <prompt>` to the Claude process.
 *
 * @param {object} capsule - Context capsule from buildContextCapsule()
 * @returns {string} Formatted prompt
 */
function buildSpawnPrompt(capsule) {
  const lines = [];

  lines.push('You are an autonomous agent spawned by the PM daemon.');
  lines.push('');

  // Task info
  lines.push(`## Task: ${capsule.task.id} — ${capsule.task.title}`);
  if (capsule.task.description) {
    lines.push('');
    lines.push('### Description');
    lines.push(capsule.task.description.slice(0, 2000));
  }
  lines.push('');

  // Resume context (highest priority — this is a respawn)
  if (capsule.resume && capsule.resume.restoration_prompt) {
    lines.push('## RESUMING FROM CHECKPOINT');
    lines.push(capsule.resume.restoration_prompt);
    lines.push('');
    lines.push('Continue from where the previous session left off.');
    lines.push('Re-read modified files before making further changes.');
    lines.push('');
  }

  // Approved plan
  if (capsule.plan && capsule.plan.content) {
    lines.push('## Approved Plan');
    lines.push('A plan was already approved for this task. Follow it:');
    lines.push('');
    lines.push(capsule.plan.content);
    lines.push('');
  }

  // Research context
  if (capsule.research) {
    lines.push('## Research Context');
    if (typeof capsule.research === 'string') {
      lines.push(capsule.research.slice(0, 2000));
    } else if (capsule.research.summary) {
      lines.push(capsule.research.summary.slice(0, 2000));
    }
    lines.push('');
  }

  // PM decisions
  if (capsule.related_decisions.length > 0) {
    lines.push('## Relevant PM Decisions');
    for (const d of capsule.related_decisions) {
      lines.push(`- ${d.decision || d.summary || JSON.stringify(d)}`);
    }
    lines.push('');
  }

  // Related agents
  if (capsule.related_agents.length > 0) {
    lines.push('## Active Agents');
    for (const a of capsule.related_agents) {
      lines.push(`- ${a.session_id}: task=${a.task || 'none'}, status=${a.status || 'unknown'}`);
    }
    lines.push('');
  }

  // Available artifacts from dependencies (Phase 4.7)
  if (capsule.artifacts && capsule.artifacts.length > 0) {
    lines.push('## Available Artifacts');
    lines.push('The following artifacts were produced by dependency tasks and are available for use:');
    lines.push('');
    for (const art of capsule.artifacts) {
      lines.push(`### ${art.name} (from ${art.task_id})`);
      lines.push('```');
      lines.push(art.content_preview);
      lines.push('```');
      lines.push('');
    }
  }

  // Instructions
  lines.push('## Instructions');
  if (capsule.resume) {
    lines.push('This is a RESUME spawn. Use /pilot-exec to continue from the last completed step.');
    lines.push('Do NOT re-plan — the plan is already approved.');
  } else if (capsule.plan) {
    lines.push('A plan is already approved. Use /pilot-exec to execute steps.');
    lines.push('Claim the task first, then start executing.');
  } else {
    lines.push('Run the full canonical loop: claim the task, plan, execute all steps, commit, and close.');
    lines.push('Use /pilot-next if you need to pick up the task, then /pilot-plan, /pilot-exec, /pilot-commit, /pilot-close.');
  }
  lines.push('Work autonomously — do not ask questions. If blocked, log the issue and move on.');

  return lines.join('\n');
}

/**
 * Detect whether a task needs resume spawning (previous agent crashed/exited mid-task).
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {{ isResume: boolean, previousSessionId?: string, checkpoint?: object }}
 */
function detectResume(taskId, projectRoot) {
  const root = projectRoot || process.cwd();
  const sessionsDir = path.join(root, '.claude/pilot/state/sessions');

  if (!fs.existsSync(sessionsDir)) {
    return { isResume: false };
  }

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

    for (const f of files) {
      const filePath = path.join(sessionsDir, f);
      try {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Find ended sessions that were working on this task
        if (state.status === 'ended' && state.claimed_task === taskId) {
          const cp = getCheckpoint();
          const checkpoint = cp ? cp.loadCheckpoint(state.session_id) : null;

          if (checkpoint) {
            return {
              isResume: true,
              previousSessionId: state.session_id,
              checkpoint
            };
          }
        }
      } catch (e) { /* skip corrupt file */ }
    }
  } catch (e) { /* skip */ }

  return { isResume: false };
}

/**
 * Gather artifact inputs that this task needs from other tasks.
 * Reads the manifest to find inputs, then loads each artifact's content preview.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {Array<{task_id: string, name: string, content_preview: string}>}
 */
function _gatherArtifacts(taskId, projectRoot) {
  const artRegistry = getArtifactRegistry();
  if (!artRegistry) return [];

  try {
    const manifest = artRegistry.getManifest(taskId, projectRoot);
    if (!manifest.inputs || manifest.inputs.length === 0) return [];

    const artifacts = [];
    for (const input of manifest.inputs) {
      const content = artRegistry.readArtifact(input.taskId, input.name, projectRoot);
      if (content !== null) {
        artifacts.push({
          task_id: input.taskId,
          name: input.name,
          content_preview: content.slice(0, 1000)
        });
      }
    }
    return artifacts;
  } catch (e) {
    return [];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  buildContextCapsule,
  buildSpawnPrompt,
  detectResume,
  // Exposed for testing
  _buildResumeContext,
  _gatherResearch,
  _loadExistingPlan,
  _gatherDecisions,
  _gatherRelatedAgents,
  _gatherArtifacts
};
