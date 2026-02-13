/**
 * Collaborative Sprint Planning — Phase 7.8 (Pilot AGI-si1p)
 *
 * Sprint kickoff with all agent souls loaded. Agents bid on tasks based
 * on expertise and growth goals. PM mediates bids with skill fit and load
 * balancing. Soul-informed effort estimates improve over sprints.
 *
 * State: .claude/pilot/state/sprint-plans/<sprintId>.json
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

const SPRINT_PLANS_DIR = '.claude/pilot/state/sprint-plans';
const MAX_BIDS_PER_TASK = 5;
const EXPERTISE_WEIGHT = 0.4;
const GROWTH_WEIGHT = 0.25;
const LOAD_WEIGHT = 0.2;
const HISTORY_WEIGHT = 0.15;

// =============================================================================
// HELPERS
// =============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function getSprintPlanPath(sprintId, projectRoot) {
  const root = projectRoot || process.cwd();
  return path.join(root, SPRINT_PLANS_DIR, sprintId + '.json');
}

// =============================================================================
// SOUL LOADING
// =============================================================================

/**
 * Load all agent souls for sprint kickoff.
 * @param {object} [opts] - { projectRoot }
 * @returns {object} Map of role -> soul context
 */
function loadAllSouls(opts) {
  const { projectRoot } = opts || {};

  let souls;
  try {
    souls = require('./souls');
  } catch (e) {
    return {};
  }

  const soulsList = souls.listSouls();
  const result = {};

  for (const entry of soulsList) {
    const role = entry.role || entry;
    const ctx = souls.loadSoulContext(role);
    if (ctx) {
      result[role] = ctx;
    }
  }

  return result;
}

// =============================================================================
// AGENT BIDDING
// =============================================================================

/**
 * Generate a bid for a task from an agent's perspective.
 * Uses soul expertise, growth goals, and past performance.
 *
 * @param {string} role - Agent role
 * @param {object} task - { id, title, description, domains, estimated_hours }
 * @param {object} [opts] - { projectRoot }
 * @returns {{ role, confidence, expertise_match, growth_alignment, estimated_hours, reasoning }}
 */
function generateBid(role, task, opts) {
  const { projectRoot } = opts || {};

  if (!role || !task || !task.id) {
    return { error: 'role and task with id required' };
  }

  let souls, assessment;
  try {
    souls = require('./souls');
  } catch (e) { souls = null; }
  try {
    assessment = require('./self-assessment');
  } catch (e) { assessment = null; }

  const soul = souls ? souls.loadSoul(role) : null;
  const taskDomains = task.domains || [];
  const taskDomainsLower = taskDomains.map(d => d.toLowerCase());

  // 1. Expertise match (0-1)
  let expertiseMatch = 0;
  if (soul && soul.expertise && taskDomainsLower.length > 0) {
    const matches = taskDomainsLower.filter(d =>
      soul.expertise.some(e => e.toLowerCase().includes(d) || d.includes(e.toLowerCase()))
    );
    expertiseMatch = matches.length / taskDomainsLower.length;
  }

  // 2. Growth alignment (0-1): tasks that match growth goals get bonus
  let growthAlignment = 0;
  if (assessment) {
    try {
      const metrics = assessment.getMetrics(role, { projectRoot });
      const gaps = assessment.detectSkillGaps(role, { projectRoot });
      // If task domain matches a skill gap, it's a growth opportunity
      if (gaps && gaps.length > 0) {
        const gapAreas = gaps.map(g => g.area.toLowerCase());
        const gapMatches = taskDomainsLower.filter(d =>
          gapAreas.some(g => g.includes(d) || d.includes(g))
        );
        growthAlignment = gapMatches.length > 0 ? 0.7 : 0;
      }
    } catch (e) { /* assessment unavailable */ }
  }

  // 3. Confidence (weighted composite)
  const confidence = Math.min(1, Math.max(0,
    expertiseMatch * EXPERTISE_WEIGHT +
    growthAlignment * GROWTH_WEIGHT +
    0.5 * LOAD_WEIGHT + // Default load factor
    0.5 * HISTORY_WEIGHT  // Default history factor
  ));

  // 4. Effort estimate based on expertise (experts estimate lower)
  const baseHours = task.estimated_hours || 4;
  const expertiseMultiplier = expertiseMatch > 0.7 ? 0.8 :
                              expertiseMatch > 0.3 ? 1.0 : 1.3;
  const estimatedHours = Math.round(baseHours * expertiseMultiplier * 10) / 10;

  // 5. Reasoning
  const reasons = [];
  if (expertiseMatch > 0.5) reasons.push('strong expertise match');
  else if (expertiseMatch > 0) reasons.push('partial expertise match');
  if (growthAlignment > 0) reasons.push('aligns with growth goals');
  if (reasons.length === 0) reasons.push('available for assignment');

  return {
    role,
    task_id: task.id,
    confidence: Math.round(confidence * 100) / 100,
    expertise_match: Math.round(expertiseMatch * 100) / 100,
    growth_alignment: Math.round(growthAlignment * 100) / 100,
    estimated_hours: estimatedHours,
    reasoning: reasons.join('; ')
  };
}

/**
 * Collect bids from all agents for a set of tasks.
 *
 * @param {Array<object>} tasks - Array of task objects
 * @param {object} [opts] - { projectRoot, excludeRoles }
 * @returns {object} Map of taskId -> Array of bids
 */
function collectBids(tasks, opts) {
  const { projectRoot, excludeRoles = ['pm'] } = opts || {};

  const allSouls = loadAllSouls({ projectRoot });
  const roles = Object.keys(allSouls).filter(r => !excludeRoles.includes(r));

  const bidsByTask = {};

  for (const task of tasks) {
    const taskBids = [];
    for (const role of roles) {
      const bid = generateBid(role, task, { projectRoot });
      if (!bid.error) {
        taskBids.push(bid);
      }
    }
    // Sort by confidence descending
    taskBids.sort((a, b) => b.confidence - a.confidence);
    bidsByTask[task.id] = taskBids.slice(0, MAX_BIDS_PER_TASK);
  }

  return bidsByTask;
}

// =============================================================================
// BID MEDIATION
// =============================================================================

/**
 * Mediate bids: resolve competing assignments.
 * Ensures each agent gets balanced workload and best-fit tasks.
 *
 * @param {object} bidsByTask - Map of taskId -> Array of bids (from collectBids)
 * @param {object} [opts] - { maxTasksPerAgent }
 * @returns {Array<{ task_id, assigned_to, confidence, reasoning }>}
 */
function mediateBids(bidsByTask, opts) {
  const { maxTasksPerAgent = 3 } = opts || {};

  const assignments = [];
  const agentLoad = {};  // role -> count of assigned tasks
  const assignedTasks = new Set();

  // Sort tasks by number of high-confidence bids (fewer options first)
  const taskIds = Object.keys(bidsByTask).sort((a, b) => {
    const aBids = bidsByTask[a].filter(bid => bid.confidence > 0.3);
    const bBids = bidsByTask[b].filter(bid => bid.confidence > 0.3);
    return aBids.length - bBids.length;
  });

  for (const taskId of taskIds) {
    if (assignedTasks.has(taskId)) continue;

    const bids = bidsByTask[taskId] || [];

    for (const bid of bids) {
      const currentLoad = agentLoad[bid.role] || 0;
      if (currentLoad >= maxTasksPerAgent) continue;

      assignments.push({
        task_id: taskId,
        assigned_to: bid.role,
        confidence: bid.confidence,
        expertise_match: bid.expertise_match,
        growth_alignment: bid.growth_alignment,
        estimated_hours: bid.estimated_hours,
        reasoning: bid.reasoning
      });

      agentLoad[bid.role] = currentLoad + 1;
      assignedTasks.add(taskId);
      break;
    }

    // If no agent could take it, leave unassigned
    if (!assignedTasks.has(taskId)) {
      assignments.push({
        task_id: taskId,
        assigned_to: null,
        confidence: 0,
        reasoning: 'no suitable agent available'
      });
    }
  }

  return assignments;
}

// =============================================================================
// EFFORT ESTIMATION
// =============================================================================

/**
 * Generate soul-informed effort estimate for a task.
 * Uses past completion times from self-assessment data.
 *
 * @param {string} role - Agent role
 * @param {object} task - { id, domains, estimated_hours }
 * @param {object} [opts] - { projectRoot }
 * @returns {{ hours: number, confidence: string, basis: string }}
 */
function estimateEffort(role, task, opts) {
  const { projectRoot } = opts || {};

  let assessment;
  try {
    assessment = require('./self-assessment');
  } catch (e) { assessment = null; }

  const baseHours = task.estimated_hours || 4;

  if (!assessment) {
    return { hours: baseHours, confidence: 'low', basis: 'default estimate' };
  }

  try {
    const metrics = assessment.getMetrics(role, { projectRoot });
    if (!metrics || !metrics.total_tasks || metrics.total_tasks === 0) {
      return { hours: baseHours, confidence: 'low', basis: 'no history' };
    }

    // Use avg_duration_minutes if available
    const avgMin = metrics.avg_duration_minutes;
    if (avgMin && avgMin > 0) {
      const historicalHours = Math.round(avgMin / 60 * 10) / 10;
      // Blend historical with base estimate
      const blended = Math.round((historicalHours * 0.6 + baseHours * 0.4) * 10) / 10;
      return {
        hours: blended,
        confidence: metrics.total_tasks >= 5 ? 'high' : 'medium',
        basis: 'historical avg (' + metrics.total_tasks + ' tasks)'
      };
    }
  } catch (e) { /* assessment error */ }

  return { hours: baseHours, confidence: 'low', basis: 'fallback' };
}

// =============================================================================
// SPRINT PLAN CREATION
// =============================================================================

/**
 * Create a collaborative sprint plan.
 * Loads all souls, collects bids, mediates assignments.
 *
 * @param {string} sprintId - Sprint identifier
 * @param {Array<object>} tasks - Tasks for the sprint
 * @param {object} [opts] - { projectRoot, maxTasksPerAgent }
 * @returns {object} Sprint plan
 */
function createSprintPlan(sprintId, tasks, opts) {
  const { projectRoot, maxTasksPerAgent = 3 } = opts || {};

  if (!sprintId || !tasks || tasks.length === 0) {
    return { error: 'sprintId and non-empty tasks array required' };
  }

  // 1. Load all souls for context
  const souls = loadAllSouls({ projectRoot });

  // 2. Collect bids
  const bids = collectBids(tasks, { projectRoot });

  // 3. Mediate
  const assignments = mediateBids(bids, { maxTasksPerAgent });

  // 4. Generate effort estimates for assigned tasks
  for (const assignment of assignments) {
    if (assignment.assigned_to) {
      const task = tasks.find(t => t.id === assignment.task_id);
      if (task) {
        const estimate = estimateEffort(assignment.assigned_to, task, { projectRoot });
        assignment.effort_estimate = estimate;
      }
    }
  }

  // 5. Build plan
  const plan = {
    sprint_id: sprintId,
    created_at: new Date().toISOString(),
    participating_agents: Object.keys(souls),
    total_tasks: tasks.length,
    assigned_tasks: assignments.filter(a => a.assigned_to).length,
    unassigned_tasks: assignments.filter(a => !a.assigned_to).length,
    assignments,
    bids_summary: Object.fromEntries(
      Object.entries(bids).map(([taskId, taskBids]) => [
        taskId,
        taskBids.map(b => ({ role: b.role, confidence: b.confidence }))
      ])
    )
  };

  // 6. Save
  writeJSON(getSprintPlanPath(sprintId, projectRoot), plan);

  return plan;
}

// =============================================================================
// RETROSPECTIVE INPUT
// =============================================================================

/**
 * Collect retrospective input from an agent based on their experience.
 *
 * @param {string} role - Agent role
 * @param {string} sprintId - Sprint to reflect on
 * @param {object} [opts] - { projectRoot }
 * @returns {{ role, strengths, improvements, learnings, suggestion }}
 */
function collectRetroInput(role, sprintId, opts) {
  const { projectRoot } = opts || {};

  let assessment;
  try {
    assessment = require('./self-assessment');
  } catch (e) { assessment = null; }

  const input = {
    role,
    sprint_id: sprintId,
    collected_at: new Date().toISOString(),
    strengths: [],
    improvements: [],
    learnings: [],
    suggestion: null
  };

  // Pull from self-assessment retrospectives
  if (assessment) {
    try {
      const retros = assessment.getRetrospectives(role, 1);
      if (retros.length > 0) {
        const latest = retros[retros.length - 1];
        input.strengths = latest.strengths || [];
        input.improvements = latest.improvements || [];
        input.learnings = latest.learnings || [];
      }
    } catch (e) { /* no retro data */ }
  }

  // Pull lessons from soul
  let souls;
  try {
    souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (soul && soul.lessons_learned && soul.lessons_learned.length > 0) {
      const recentLessons = soul.lessons_learned.slice(-3).map(l => l.lesson);
      input.learnings = [...new Set([...input.learnings, ...recentLessons])];
    }
  } catch (e) { /* souls unavailable */ }

  return input;
}

/**
 * Aggregate retrospective inputs from all agents.
 *
 * @param {string} sprintId
 * @param {object} [opts] - { projectRoot }
 * @returns {{ sprint_id, inputs: Array, common_themes: Array }}
 */
function aggregateRetro(sprintId, opts) {
  const { projectRoot } = opts || {};

  const allSouls = loadAllSouls({ projectRoot });
  const roles = Object.keys(allSouls).filter(r => r !== 'pm');

  const inputs = [];
  for (const role of roles) {
    const input = collectRetroInput(role, sprintId, { projectRoot });
    inputs.push(input);
  }

  // Find common themes across agents
  const allStrengths = inputs.flatMap(i => i.strengths);
  const allImprovements = inputs.flatMap(i => i.improvements);

  const themes = [];
  const strengthCounts = {};
  for (const s of allStrengths) {
    const key = s.toLowerCase();
    strengthCounts[key] = (strengthCounts[key] || 0) + 1;
    if (strengthCounts[key] >= 2 && !themes.some(t => t.theme === key)) {
      themes.push({ theme: key, type: 'strength', count: strengthCounts[key] });
    }
  }

  const improveCounts = {};
  for (const s of allImprovements) {
    const key = s.toLowerCase();
    improveCounts[key] = (improveCounts[key] || 0) + 1;
    if (improveCounts[key] >= 2 && !themes.some(t => t.theme === key)) {
      themes.push({ theme: key, type: 'improvement', count: improveCounts[key] });
    }
  }

  return {
    sprint_id: sprintId,
    inputs,
    common_themes: themes,
    aggregated_at: new Date().toISOString()
  };
}

// =============================================================================
// PLAN HISTORY
// =============================================================================

/**
 * Load a saved sprint plan.
 * @param {string} sprintId
 * @param {object} [opts] - { projectRoot }
 * @returns {object | null}
 */
function loadSprintPlan(sprintId, opts) {
  const { projectRoot } = opts || {};
  return readJSON(getSprintPlanPath(sprintId, projectRoot));
}

/**
 * List all sprint plans.
 * @param {object} [opts] - { projectRoot }
 * @returns {string[]} Sprint IDs
 */
function listSprintPlans(opts) {
  const { projectRoot } = opts || {};
  const root = projectRoot || process.cwd();
  const dir = path.join(root, SPRINT_PLANS_DIR);

  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Soul loading
  loadAllSouls,

  // Bidding
  generateBid,
  collectBids,

  // Mediation
  mediateBids,

  // Estimation
  estimateEffort,

  // Sprint planning
  createSprintPlan,

  // Retrospective
  collectRetroInput,
  aggregateRetro,

  // History
  loadSprintPlan,
  listSprintPlans,

  // Constants (for testing)
  _SPRINT_PLANS_DIR: SPRINT_PLANS_DIR,
  _MAX_BIDS_PER_TASK: MAX_BIDS_PER_TASK,
  _EXPERTISE_WEIGHT: EXPERTISE_WEIGHT,
  _GROWTH_WEIGHT: GROWTH_WEIGHT,
  _LOAD_WEIGHT: LOAD_WEIGHT,
  _HISTORY_WEIGHT: HISTORY_WEIGHT
};
