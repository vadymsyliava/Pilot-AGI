/**
 * Intelligent Task Scheduler (Phase 3.4)
 *
 * Replaces simple round-robin task assignment with intelligent scheduling:
 * - Skill-based routing (delegates to orchestrator.scoreAgentForTask)
 * - Load balancing (task count + complexity weighting per agent)
 * - Priority-aware scheduling with starvation prevention
 * - Dependency-aware assignment (only tasks whose deps are complete)
 * - Context pre-loading (memory + research injection with assignment)
 *
 * Used by pm-loop.js _taskScan() to batch-schedule all ready tasks.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Lazy-loaded dependencies to avoid circular requires
let _session = null;
let _orchestrator = null;
let _costTracker = null;
let _pmResearch = null;
let _memory = null;
let _policy = null;
let _artifactRegistry = null;
let _modelScheduler = null;
let _adapterRegistry = null;

function getSession() {
  if (!_session) _session = require('./session');
  return _session;
}

function getOrchestrator() {
  if (!_orchestrator) _orchestrator = require('./orchestrator');
  return _orchestrator;
}

function getCostTracker() {
  if (!_costTracker) {
    try { _costTracker = require('./cost-tracker'); } catch (e) { _costTracker = null; }
  }
  return _costTracker;
}

function getPmResearch() {
  if (!_pmResearch) {
    try { _pmResearch = require('./pm-research'); } catch (e) { _pmResearch = null; }
  }
  return _pmResearch;
}

function getMemory() {
  if (!_memory) {
    try { _memory = require('./memory'); } catch (e) { _memory = null; }
  }
  return _memory;
}

function getArtifactRegistry() {
  if (!_artifactRegistry) {
    try { _artifactRegistry = require('./artifact-registry'); } catch (e) { _artifactRegistry = null; }
  }
  return _artifactRegistry;
}

function getModelScheduler(projectRoot) {
  if (!_modelScheduler) {
    try { _modelScheduler = require('./model-scheduler').getModelScheduler({ projectRoot }); } catch (e) { _modelScheduler = null; }
  }
  return _modelScheduler;
}

function getAdapterRegistry() {
  if (!_adapterRegistry) {
    try { _adapterRegistry = require('./agent-adapter-registry').getRegistry(); } catch (e) { _adapterRegistry = null; }
  }
  return _adapterRegistry;
}

function getPolicy() {
  if (!_policy) {
    try {
      const { loadPolicy } = require('./policy');
      _policy = loadPolicy;
    } catch (e) {
      _policy = () => ({});
    }
  }
  return _policy;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG = {
  // Load balancing weights
  load_weight: 0.20,          // Weight for agent load in final score
  skill_weight: 0.55,         // Weight for skill match (from scoreAgentForTask)
  affinity_weight: 0.15,      // Weight for historical affinity
  cost_weight: 0.10,          // Weight for cost efficiency

  // Load calculation
  max_tasks_per_agent: 3,     // Soft cap on concurrent tasks per agent
  complexity_multiplier: {    // How much each size counts toward load
    S: 1,
    M: 2,
    L: 3
  },

  // Starvation prevention
  starvation_threshold_sec: 300, // 5 minutes: boost priority of starved tasks
  starvation_boost_per_sec: 0.001, // Priority boost per second past threshold

  // Priority mapping (P1-P4 → numeric weight)
  priority_weights: {
    1: 1.0,   // P1: Critical
    2: 0.7,   // P2: High
    3: 0.4,   // P3: Medium
    4: 0.2    // P4: Low
  }
};

// ============================================================================
// SCHEDULER CONFIG
// ============================================================================

/**
 * Load scheduler config from policy.yaml, merged with defaults.
 */
function loadSchedulerConfig() {
  try {
    const policy = getPolicy()();
    const cfg = policy?.orchestrator?.scheduling || {};
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

// ============================================================================
// DEPENDENCY CHECKING
// ============================================================================

/**
 * Check if a task's dependencies are all satisfied (closed in bd).
 *
 * @param {string} taskId - bd task ID
 * @param {string} projectRoot - Project root directory
 * @returns {{ ready: boolean, blocking: string[] }}
 */
function checkDependencies(taskId, projectRoot) {
  let blocking = [];

  // 1. Check bd task graph dependencies
  try {
    const output = execFileSync('bd', ['deps', taskId, '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const deps = JSON.parse(output);

    // Filter to only dependency edges where this task depends on another
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (dep.dependent === taskId && dep.status !== 'closed') {
          blocking.push(dep.dependency || dep.id);
        }
      }
    }
  } catch (e) {
    // If bd deps fails, assume ready (don't block on tooling errors)
  }

  // 2. Check artifact dependencies (Phase 4.7)
  let blockingArtifacts = [];
  const artRegistry = getArtifactRegistry();
  if (artRegistry) {
    try {
      blockingArtifacts = artRegistry.getBlockingArtifacts(taskId, projectRoot);
    } catch (e) {
      // Don't block on artifact registry errors
    }
  }

  const ready = blocking.length === 0 && blockingArtifacts.length === 0;
  return { ready, blocking, blocking_artifacts: blockingArtifacts };
}

// ============================================================================
// LOAD BALANCING
// ============================================================================

/**
 * Calculate current load for an agent session.
 * Load = sum of complexity weights for all active tasks.
 *
 * @param {string} sessionId - Agent session ID
 * @param {object} config - Scheduler config
 * @returns {{ load: number, task_count: number, available_capacity: number }}
 */
function getAgentLoad(sessionId, config) {
  const session = getSession();
  const allSessions = session.getAllSessionStates();
  const sessionData = allSessions.find(s => s.session_id === sessionId);

  if (!sessionData || sessionData.status !== 'active') {
    return { load: 0, task_count: 0, available_capacity: 0 };
  }

  // Current claimed task counts as load
  let load = 0;
  let taskCount = 0;

  if (sessionData.claimed_task) {
    taskCount = 1;
    // Try to determine complexity from task metadata
    const complexity = getTaskComplexity(sessionData.claimed_task);
    load = config.complexity_multiplier[complexity] || 1;
  }

  const maxLoad = config.max_tasks_per_agent * config.complexity_multiplier.M; // Normalize to M-equivalent
  const availableCapacity = Math.max(0, maxLoad - load);

  return { load, task_count: taskCount, available_capacity: availableCapacity };
}

/**
 * Get task complexity classification.
 * Uses decomposition module's classification if available.
 *
 * @param {string} taskId - bd task ID
 * @returns {'S'|'M'|'L'}
 */
function getTaskComplexity(taskId) {
  const pmResearch = getPmResearch();
  if (!pmResearch) return 'M';

  try {
    // Try to get cached classification
    const cached = pmResearch.checkResearchCache(taskId);
    if (cached && cached.complexity) return cached.complexity;
  } catch (e) {
    // Fallback
  }

  return 'M'; // Default to medium
}

/**
 * Calculate load score for an agent (0 = fully loaded, 1 = fully available).
 *
 * @param {string} sessionId
 * @param {object} config
 * @returns {number} 0-1 availability score
 */
function loadScore(sessionId, config) {
  const { load, available_capacity } = getAgentLoad(sessionId, config);
  const maxLoad = config.max_tasks_per_agent * config.complexity_multiplier.M;

  if (maxLoad === 0) return 0;
  return Math.max(0, Math.min(1, available_capacity / maxLoad));
}

// ============================================================================
// STARVATION PREVENTION
// ============================================================================

/**
 * Calculate priority boost for a task based on how long it's been waiting.
 * Tasks waiting longer than threshold get progressively higher priority.
 *
 * @param {object} task - Task with created_at timestamp
 * @param {object} config - Scheduler config
 * @returns {number} Priority boost (0 if not starved)
 */
function starvationBoost(task, config) {
  if (!task.created_at) return 0;

  const createdAt = new Date(task.created_at).getTime();
  const now = Date.now();
  const waitSec = (now - createdAt) / 1000;

  if (waitSec <= config.starvation_threshold_sec) return 0;

  const overdue = waitSec - config.starvation_threshold_sec;
  return Math.min(overdue * config.starvation_boost_per_sec, 0.5); // Cap at 0.5 boost
}

// ============================================================================
// AFFINITY SCORING
// ============================================================================

/**
 * Get affinity score for an agent on a specific task.
 * Based on historical success with similar tasks/files.
 *
 * @param {string} sessionId
 * @param {string} role - Agent role
 * @param {object} task - Task object
 * @returns {number} 0-1 affinity score
 */
function affinityScore(sessionId, role, task) {
  const session = getSession();

  try {
    const affinity = session.getAgentAffinity(role);
    if (!affinity || !affinity.tasks || affinity.tasks.length === 0) return 0;

    // Check file overlap: do the task's files match areas this agent has worked on
    const taskFiles = task.files || [];
    const taskLabels = task.labels || [];
    const taskText = `${task.title || ''} ${task.description || ''}`.toLowerCase();

    let matchCount = 0;
    let totalChecks = 0;

    // Check if agent has succeeded with similar labels/keywords
    for (const entry of affinity.tasks.slice(-20)) { // Last 20 tasks
      if (entry.outcome === 'completed') {
        // Label overlap
        const entryLabels = entry.labels || [];
        const labelOverlap = taskLabels.filter(l => entryLabels.includes(l)).length;
        if (labelOverlap > 0) matchCount++;
        totalChecks++;

        // File area overlap
        const entryFiles = entry.files || [];
        const fileOverlap = taskFiles.filter(f =>
          entryFiles.some(ef => {
            // Same directory tree?
            const fDir = path.dirname(f);
            const efDir = path.dirname(ef);
            return fDir === efDir || f.startsWith(efDir) || ef.startsWith(fDir);
          })
        ).length;
        if (fileOverlap > 0) matchCount++;
        totalChecks++;
      }
    }

    return totalChecks > 0 ? Math.min(matchCount / totalChecks, 1) : 0;
  } catch (e) {
    return 0;
  }
}

// ============================================================================
// CONTEXT PRE-LOADING
// ============================================================================

/**
 * Build context package to inject when assigning a task to an agent.
 * Includes research findings, memory channel data, and dependency outputs.
 *
 * @param {object} task - Task object
 * @param {string} projectRoot - Project root
 * @returns {object} Context package
 */
function buildContextPackage(task, projectRoot) {
  const context = {
    research: null,
    memory: {},
    dependency_outputs: [],
    related_decisions: []
  };

  // 1. Research context (Phase 3.2)
  const pmResearch = getPmResearch();
  if (pmResearch) {
    try {
      context.research = pmResearch.buildResearchContext(task.id);
    } catch (e) { /* skip */ }
  }

  // 2. Relevant memory channels
  const mem = getMemory();
  if (mem) {
    try {
      // Get PM decisions related to this task
      const decisions = mem.read('pm-decisions');
      if (decisions && decisions.entries) {
        context.related_decisions = decisions.entries
          .filter(e => e.task_id === task.id || (task.labels || []).some(l => (e.labels || []).includes(l)))
          .slice(-5); // Last 5 relevant decisions
      }

      // Get task decomposition context if this is a subtask
      const decomps = mem.read('task-decompositions');
      if (decomps && decomps.entries) {
        const parentDecomp = decomps.entries.find(e =>
          e.subtasks && e.subtasks.some(st => st.id === task.id)
        );
        if (parentDecomp) {
          context.parent_task = parentDecomp.parent_id;
          context.sibling_tasks = parentDecomp.subtasks.map(st => st.id);
        }
      }
    } catch (e) { /* skip */ }
  }

  return context;
}

// ============================================================================
// MAIN SCHEDULER
// ============================================================================

/**
 * Score a single agent for a specific task, combining all factors.
 *
 * @param {object} agent - Agent { session_id, role, agent_name }
 * @param {object} task - Task object
 * @param {object} registry - Skill registry
 * @param {object} config - Scheduler config
 * @returns {{ score: number, breakdown: object }}
 */
function scoreAssignment(agent, task, registry, config) {
  const orch = getOrchestrator();

  // 1. Skill match score (existing orchestrator logic)
  const skillScore = orch.scoreAgentForTask(agent.role, task, registry, agent.session_id);

  // 2. Load score (availability)
  const load = loadScore(agent.session_id, config);

  // 3. Affinity score (historical success)
  const affinity = affinityScore(agent.session_id, agent.role, task);

  // 4. Cost efficiency (from 3.11, already partially in scoreAgentForTask)
  let costScore = 0.5; // neutral default
  const ct = getCostTracker();
  if (ct) {
    try {
      const eff = ct.getAgentEfficiency(agent.session_id);
      if (eff.avg_tokens_per_task !== null && eff.tasks_completed >= 2) {
        costScore = Math.max(0, 1 - (eff.avg_tokens_per_task / 200000));
      }
    } catch (e) { /* skip */ }
  }

  // 5. Combine with configurable weights
  const combined = (
    skillScore * config.skill_weight +
    load * config.load_weight +
    affinity * config.affinity_weight +
    costScore * config.cost_weight
  );

  return {
    score: combined,
    breakdown: {
      skill: skillScore,
      load,
      affinity,
      cost: costScore,
      weights: {
        skill: config.skill_weight,
        load: config.load_weight,
        affinity: config.affinity_weight,
        cost: config.cost_weight
      }
    }
  };
}

/**
 * Schedule all ready tasks to available agents in one batch.
 *
 * Returns an ordered list of assignments: [{ task, agent, score, context }]
 *
 * Algorithm:
 * 1. Get all ready tasks + all available agents
 * 2. Sort tasks by effective priority (base priority + starvation boost)
 * 3. For each task (highest priority first):
 *    a. Check dependencies → skip if not ready
 *    b. Score all unassigned agents
 *    c. Pick best agent above threshold
 *    d. Mark agent as assigned (can't be double-booked this round)
 * 4. Build context packages for each assignment
 *
 * @param {object[]} readyTasks - Tasks from bd ready
 * @param {string} excludeSessionId - PM session to exclude
 * @param {string} projectRoot - Project root
 * @returns {{ assignments: object[], unassigned_tasks: object[], no_agents: boolean }}
 */
function schedule(readyTasks, excludeSessionId, projectRoot) {
  const config = loadSchedulerConfig();
  const session = getSession();
  const orch = getOrchestrator();

  // Load skill registry
  const registry = orch.loadSkillRegistry();
  if (!registry) {
    return {
      assignments: [],
      unassigned_tasks: readyTasks,
      no_agents: true,
      reason: 'No skill registry found'
    };
  }

  // Get available agents
  const available = session.getAvailableAgents(excludeSessionId);
  if (available.length === 0) {
    return {
      assignments: [],
      unassigned_tasks: readyTasks.map(t => ({ task: t, reason: 'no_agents_available' })),
      no_agents: true,
      reason: 'No available agents'
    };
  }

  const threshold = registry.scoring?.confidence_threshold || 0.3;

  // Sort tasks by effective priority (base + starvation boost)
  const prioritized = readyTasks.map(task => {
    const basePriority = config.priority_weights[task.priority] || 0.3;
    const boost = starvationBoost(task, config);
    return {
      task,
      effective_priority: basePriority + boost,
      starvation_boost: boost
    };
  }).sort((a, b) => b.effective_priority - a.effective_priority);

  const assignments = [];
  const unassignedTasks = [];
  const assignedAgents = new Set();

  for (const { task, effective_priority, starvation_boost: boost } of prioritized) {
    // Check dependencies
    const depCheck = checkDependencies(task.id, projectRoot);
    if (!depCheck.ready) {
      unassignedTasks.push({
        task,
        reason: 'blocked',
        blocking: depCheck.blocking
      });
      continue;
    }

    // Score all unassigned agents for this task
    const candidates = available
      .filter(a => !assignedAgents.has(a.session_id))
      .map(agent => {
        const { score, breakdown } = scoreAssignment(agent, task, registry, config);
        return { agent, score, breakdown };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      unassignedTasks.push({ task, reason: 'no_agents_available' });
      continue;
    }

    const best = candidates[0];

    // Check threshold (but lower it for starved tasks)
    const effectiveThreshold = Math.max(0.1, threshold - boost);
    if (best.score < effectiveThreshold) {
      // Try fallback: any idle agent without role matching
      const fallback = available.find(a =>
        !assignedAgents.has(a.session_id) && !a.claimed_task
      );
      if (fallback) {
        assignedAgents.add(fallback.session_id);
        assignments.push({
          task,
          agent: fallback,
          score: 0,
          breakdown: { fallback: true, reason: `No agent scored above ${effectiveThreshold.toFixed(2)}` },
          effective_priority,
          context: buildContextPackage(task, projectRoot)
        });
      } else {
        unassignedTasks.push({
          task,
          reason: 'below_threshold',
          best_score: best.score,
          threshold: effectiveThreshold
        });
      }
      continue;
    }

    assignedAgents.add(best.agent.session_id);
    assignments.push({
      task,
      agent: best.agent,
      score: best.score,
      breakdown: best.breakdown,
      effective_priority,
      context: buildContextPackage(task, projectRoot)
    });
  }

  return {
    assignments,
    unassigned_tasks: unassignedTasks,
    no_agents: false
  };
}

/**
 * Get a single next-best assignment for a specific ready task.
 * Convenience wrapper when scheduling one task at a time.
 *
 * @param {object} task - Single task
 * @param {string} excludeSessionId
 * @param {string} projectRoot
 * @returns {{ agent: object|null, score: number, context: object, reason: string }}
 */
function scheduleOne(task, excludeSessionId, projectRoot) {
  const result = schedule([task], excludeSessionId, projectRoot);

  if (result.assignments.length > 0) {
    const a = result.assignments[0];
    return {
      agent: a.agent,
      score: a.score,
      breakdown: a.breakdown,
      context: a.context,
      reason: `Best match: ${a.agent.agent_name} (${a.agent.role}) scored ${a.score.toFixed(2)}`
    };
  }

  const reason = result.unassigned_tasks.length > 0
    ? result.unassigned_tasks[0].reason
    : result.reason || 'No assignment possible';

  return { agent: null, score: 0, breakdown: null, context: null, reason };
}

// ============================================================================
// MODEL-AWARE SCHEDULING (Phase 6.12)
// ============================================================================

/**
 * Schedule with model selection: for each task, pick the best model AND agent.
 * Wraps schedule() and enriches each assignment with a model recommendation.
 *
 * @param {object[]} readyTasks - Tasks from bd ready
 * @param {string} excludeSessionId - PM session to exclude
 * @param {string} projectRoot - Project root
 * @returns {{ assignments: object[], unassigned_tasks: object[], no_agents: boolean }}
 */
function scheduleWithModel(readyTasks, excludeSessionId, projectRoot) {
  // Run normal agent scheduling first
  const result = schedule(readyTasks, excludeSessionId, projectRoot);

  // Enrich assignments with model recommendation
  const ms = getModelScheduler(projectRoot);
  const ar = getAdapterRegistry();

  if (!ms || !ar) {
    // Model scheduler not available — return plain scheduling results
    return result;
  }

  // Get available adapter names
  const availableAdapters = ar.hasDetected
    ? ar.getAvailable().map(a => a.name)
    : ['claude']; // Default: only Claude available if not detected

  for (const assignment of result.assignments) {
    try {
      const modelSelection = ms.selectModel(assignment.task, availableAdapters);
      assignment.model = modelSelection;
    } catch (e) {
      // Model selection failed — leave assignment without model recommendation
      assignment.model = null;
    }
  }

  return result;
}

/**
 * Select the best model for a single task (without agent assignment).
 * Useful when the PM already knows which agent to use but wants to pick the model.
 *
 * @param {object} task - Task object
 * @param {string} projectRoot
 * @returns {{ modelId: string, adapterId: string, score: number, breakdown: object } | null}
 */
function selectModelForTask(task, projectRoot) {
  const ms = getModelScheduler(projectRoot);
  const ar = getAdapterRegistry();

  if (!ms) return null;

  const availableAdapters = ar?.hasDetected
    ? ar.getAvailable().map(a => a.name)
    : ['claude'];

  return ms.selectModel(task, availableAdapters);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main API
  schedule,
  scheduleOne,
  scheduleWithModel,
  selectModelForTask,

  // Sub-components (for testing / custom use)
  loadSchedulerConfig,
  checkDependencies,
  getAgentLoad,
  getTaskComplexity,
  loadScore,
  starvationBoost,
  affinityScore,
  buildContextPackage,
  scoreAssignment,

  // Constants
  DEFAULT_CONFIG
};
