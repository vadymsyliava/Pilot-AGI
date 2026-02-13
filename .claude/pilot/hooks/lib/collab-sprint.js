/**
 * Collaborative Sprint Planning — Phase 7.8 (Pilot AGI-si1p)
 *
 * Sprint planning with agent soul participation. Agents bid on tasks
 * based on expertise and growth goals; PM mediates competing bids.
 * Agents commit with soul-informed effort estimates. Retrospective
 * contributions feed back into soul learning.
 *
 * Flow:
 * 1. PM triggers sprint planning with task list
 * 2. Agents generate bids (expertise match + growth goals + availability)
 * 3. PM resolves conflicts (competing bids for same task)
 * 4. Agents commit with effort estimates
 * 5. Post-sprint retrospective with per-agent contributions
 *
 * State: .claude/pilot/state/sprints/<sprintId>.json
 */

const fs = require('fs');
const path = require('path');

const SPRINT_STATE_DIR = '.claude/pilot/state/sprints';
const MAX_BIDS_PER_TASK = 5;
const MAX_RETRO_ENTRIES = 20;

const SPRINT_STATUS = {
  PLANNING: 'planning',
  BIDDING: 'bidding',
  COMMITTED: 'committed',
  ACTIVE: 'active',
  RETROSPECTIVE: 'retrospective',
  CLOSED: 'closed'
};

// =============================================================================
// PATH HELPERS
// =============================================================================

function getSprintDir() {
  return path.join(process.cwd(), SPRINT_STATE_DIR);
}

function getSprintPath(sprintId) {
  const sanitized = sprintId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(getSprintDir(), `${sanitized}.json`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// SPRINT LIFECYCLE
// =============================================================================

/**
 * Initialize a new sprint for collaborative planning.
 *
 * @param {string} sprintId - Sprint identifier
 * @param {object[]} tasks - Tasks for the sprint [{ id, description, areas, estimate? }]
 * @param {string[]} agentRoles - Available agent roles
 * @returns {{ success, sprint }}
 */
function initializeSprint(sprintId, tasks, agentRoles) {
  if (!sprintId || !tasks || tasks.length === 0 || !agentRoles || agentRoles.length === 0) {
    return { success: false, error: 'sprintId, tasks, and agentRoles required' };
  }

  const sprint = {
    sprint_id: sprintId,
    status: SPRINT_STATUS.PLANNING,
    tasks: tasks.map(t => ({
      id: t.id,
      description: t.description || '',
      areas: t.areas || [],
      estimate: t.estimate || null,
      bids: [],
      assigned_to: null,
      committed: false,
      actual_duration: null
    })),
    agents: agentRoles.map(role => ({
      role,
      bids_count: 0,
      committed_tasks: [],
      retro_contribution: null
    })),
    retrospective: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  saveSprint(sprintId, sprint);
  return { success: true, sprint };
}

// =============================================================================
// AGENT BIDDING
// =============================================================================

/**
 * Agent places a bid on a task based on expertise and interest.
 *
 * @param {string} sprintId - Sprint ID
 * @param {string} taskId - Task ID to bid on
 * @param {string} role - Agent role placing the bid
 * @param {object} bid - { confidence, reason, estimated_hours, growth_opportunity? }
 * @returns {{ success, bid_count }}
 */
function placeBid(sprintId, taskId, role, bid) {
  if (!sprintId || !taskId || !role || !bid) {
    return { success: false, error: 'sprintId, taskId, role, and bid required' };
  }

  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  const task = sprint.tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: 'task not found in sprint' };

  if (task.bids.length >= MAX_BIDS_PER_TASK) {
    return { success: false, error: 'max bids reached for this task' };
  }

  // Check for duplicate bid
  if (task.bids.some(b => b.role === role)) {
    return { success: false, error: 'agent already bid on this task' };
  }

  // Calculate expertise score from soul
  let expertiseScore = 0;
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (soul && soul.expertise) {
      for (const area of task.areas) {
        if (soul.expertise.some(e => e.toLowerCase().includes(area.toLowerCase()))) {
          expertiseScore += 20;
        }
      }
    }
  } catch (e) {}

  // Calculate growth score
  let growthScore = 0;
  try {
    const sa = require('./self-assessment');
    const gaps = sa.detectSkillGaps(role);
    if (gaps.gaps && gaps.gaps.some(g => task.areas.includes(g.area))) {
      growthScore = 15; // Growth opportunity
    }
  } catch (e) {}

  const bidEntry = {
    role,
    confidence: bid.confidence || 50,
    reason: bid.reason || '',
    estimated_hours: bid.estimated_hours || null,
    growth_opportunity: bid.growth_opportunity || false,
    expertise_score: expertiseScore,
    growth_score: growthScore,
    total_score: (bid.confidence || 50) + expertiseScore + growthScore,
    placed_at: new Date().toISOString()
  };

  task.bids.push(bidEntry);

  // Update agent bid count
  const agent = sprint.agents.find(a => a.role === role);
  if (agent) agent.bids_count++;

  sprint.status = SPRINT_STATUS.BIDDING;
  sprint.updated_at = new Date().toISOString();
  saveSprint(sprintId, sprint);

  return { success: true, bid_count: task.bids.length, total_score: bidEntry.total_score };
}

/**
 * Auto-generate bids for an agent based on soul expertise and gaps.
 *
 * @param {string} sprintId - Sprint ID
 * @param {string} role - Agent role
 * @returns {{ success, bids_placed }}
 */
function autoBid(sprintId, role) {
  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  let bidsPlaced = 0;

  // Load agent capabilities
  let capabilities = [];
  try {
    const regPath = path.join(process.cwd(), '.claude/pilot/agent-registry.json');
    if (fs.existsSync(regPath)) {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      capabilities = (reg.agents[role] && reg.agents[role].capabilities) || [];
    }
  } catch (e) {}

  for (const task of sprint.tasks) {
    if (task.assigned_to) continue; // Already assigned
    if (task.bids.some(b => b.role === role)) continue; // Already bid

    // Check if capabilities match task areas
    const match = task.areas.some(area =>
      capabilities.some(cap => cap.includes(area) || area.includes(cap))
    );

    if (match) {
      const confidence = 60 + Math.floor(Math.random() * 30); // 60-89
      placeBid(sprintId, task.id, role, {
        confidence,
        reason: 'auto-bid based on capability match',
        estimated_hours: 2
      });
      bidsPlaced++;
    }
  }

  return { success: true, bids_placed: bidsPlaced };
}

// =============================================================================
// PM MEDIATION
// =============================================================================

/**
 * PM resolves competing bids for tasks.
 * Assigns tasks based on total_score (expertise + confidence + growth).
 * Balances load across agents.
 *
 * @param {string} sprintId - Sprint ID
 * @returns {{ success, assignments }}
 */
function resolveBids(sprintId) {
  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  const assignments = [];
  const agentLoad = {};

  // Initialize load counters
  for (const agent of sprint.agents) {
    agentLoad[agent.role] = 0;
  }

  // Sort tasks by number of bids (fewer bids = harder to fill, assign first)
  const sortedTasks = [...sprint.tasks]
    .filter(t => !t.assigned_to && t.bids.length > 0)
    .sort((a, b) => a.bids.length - b.bids.length);

  for (const task of sortedTasks) {
    // Sort bids by total score, then apply load balancing penalty
    const scoredBids = task.bids.map(bid => ({
      ...bid,
      adjusted_score: bid.total_score - (agentLoad[bid.role] || 0) * 10
    })).sort((a, b) => b.adjusted_score - a.adjusted_score);

    if (scoredBids.length > 0) {
      const winner = scoredBids[0];

      // Assign
      const sprintTask = sprint.tasks.find(t => t.id === task.id);
      sprintTask.assigned_to = winner.role;
      sprintTask.estimated_hours = winner.estimated_hours;

      // Update load
      agentLoad[winner.role] = (agentLoad[winner.role] || 0) + 1;

      // Update agent committed tasks
      const agent = sprint.agents.find(a => a.role === winner.role);
      if (agent) agent.committed_tasks.push(task.id);

      assignments.push({
        task_id: task.id,
        assigned_to: winner.role,
        score: winner.total_score,
        reason: winner.reason
      });
    }
  }

  sprint.status = SPRINT_STATUS.COMMITTED;
  sprint.updated_at = new Date().toISOString();
  saveSprint(sprintId, sprint);

  return { success: true, assignments };
}

// =============================================================================
// COMMITMENT PROTOCOL
// =============================================================================

/**
 * Agent confirms commitment to assigned task with effort estimate.
 *
 * @param {string} sprintId
 * @param {string} taskId
 * @param {string} role
 * @param {object} commitment - { estimated_hours, notes? }
 * @returns {{ success }}
 */
function confirmCommitment(sprintId, taskId, role, commitment) {
  if (!sprintId || !taskId || !role) {
    return { success: false, error: 'sprintId, taskId, and role required' };
  }

  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  const task = sprint.tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: 'task not found' };
  if (task.assigned_to !== role) return { success: false, error: 'task not assigned to this agent' };

  task.committed = true;
  task.estimated_hours = commitment.estimated_hours || task.estimated_hours;
  task.commitment_notes = commitment.notes || null;
  task.committed_at = new Date().toISOString();

  sprint.updated_at = new Date().toISOString();

  // Check if all assigned tasks are committed
  const allCommitted = sprint.tasks
    .filter(t => t.assigned_to)
    .every(t => t.committed);
  if (allCommitted) {
    sprint.status = SPRINT_STATUS.ACTIVE;
  }

  saveSprint(sprintId, sprint);
  return { success: true, all_committed: allCommitted };
}

// =============================================================================
// RETROSPECTIVE
// =============================================================================

/**
 * Agent contributes to sprint retrospective.
 *
 * @param {string} sprintId
 * @param {string} role - Agent role
 * @param {object} contribution - { went_well[], could_improve[], learnings[] }
 * @returns {{ success }}
 */
function contributeRetro(sprintId, role, contribution) {
  if (!sprintId || !role || !contribution) {
    return { success: false, error: 'sprintId, role, and contribution required' };
  }

  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  // Remove existing contribution from same agent
  sprint.retrospective = sprint.retrospective.filter(r => r.role !== role);

  if (sprint.retrospective.length >= MAX_RETRO_ENTRIES) {
    return { success: false, error: 'max retro entries reached' };
  }

  sprint.retrospective.push({
    role,
    went_well: contribution.went_well || [],
    could_improve: contribution.could_improve || [],
    learnings: contribution.learnings || [],
    contributed_at: new Date().toISOString()
  });

  // Update agent record
  const agent = sprint.agents.find(a => a.role === role);
  if (agent) agent.retro_contribution = new Date().toISOString();

  sprint.status = SPRINT_STATUS.RETROSPECTIVE;
  sprint.updated_at = new Date().toISOString();
  saveSprint(sprintId, sprint);

  // Write learnings to soul
  syncRetroToSoul(role, contribution, sprintId);

  return { success: true, contributions: sprint.retrospective.length };
}

/**
 * Sync retrospective learnings to agent soul.
 */
function syncRetroToSoul(role, contribution, sprintId) {
  try {
    const souls = require('./souls');

    if (contribution.learnings && contribution.learnings.length > 0) {
      const lesson = `Sprint ${sprintId}: ${contribution.learnings.slice(0, 2).join('; ')}`;
      souls.recordLesson(role, lesson, sprintId);
    }

    if (contribution.could_improve && contribution.could_improve.length > 0) {
      const lesson = `Growth area from sprint ${sprintId}: ${contribution.could_improve[0]}`;
      souls.recordLesson(role, lesson, sprintId);
    }
  } catch (e) {
    // Best effort
  }
}

/**
 * Record actual task duration for estimate accuracy tracking.
 */
function recordActualDuration(sprintId, taskId, actualHours) {
  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  const task = sprint.tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: 'task not found' };

  task.actual_duration = actualHours;
  sprint.updated_at = new Date().toISOString();
  saveSprint(sprintId, sprint);

  return {
    success: true,
    estimated: task.estimated_hours,
    actual: actualHours,
    accuracy: task.estimated_hours
      ? Math.round((1 - Math.abs(task.estimated_hours - actualHours) / task.estimated_hours) * 100)
      : null
  };
}

/**
 * Get sprint summary with estimate accuracy and per-agent stats.
 */
function getSprintSummary(sprintId) {
  const sprint = loadSprint(sprintId);
  if (!sprint) return null;

  const taskStats = {
    total: sprint.tasks.length,
    assigned: sprint.tasks.filter(t => t.assigned_to).length,
    committed: sprint.tasks.filter(t => t.committed).length,
    unassigned: sprint.tasks.filter(t => !t.assigned_to).length
  };

  // Estimate accuracy
  const tasksWithBoth = sprint.tasks.filter(t => t.estimated_hours && t.actual_duration);
  let estimateAccuracy = null;
  if (tasksWithBoth.length > 0) {
    const accuracies = tasksWithBoth.map(t =>
      1 - Math.abs(t.estimated_hours - t.actual_duration) / t.estimated_hours
    );
    estimateAccuracy = Math.round(
      (accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 100
    );
  }

  return {
    sprint_id: sprint.sprint_id,
    status: sprint.status,
    tasks: taskStats,
    estimate_accuracy: estimateAccuracy,
    retro_contributions: sprint.retrospective.length,
    agents: sprint.agents.map(a => ({
      role: a.role,
      tasks_assigned: a.committed_tasks.length,
      retro_contributed: !!a.retro_contribution
    })),
    created_at: sprint.created_at,
    updated_at: sprint.updated_at
  };
}

/**
 * Close a sprint.
 */
function closeSprint(sprintId) {
  const sprint = loadSprint(sprintId);
  if (!sprint) return { success: false, error: 'sprint not found' };

  sprint.status = SPRINT_STATUS.CLOSED;
  sprint.closed_at = new Date().toISOString();
  sprint.updated_at = new Date().toISOString();
  saveSprint(sprintId, sprint);

  return { success: true };
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

function loadSprint(sprintId) {
  const filePath = getSprintPath(sprintId);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveSprint(sprintId, sprint) {
  const dir = getSprintDir();
  ensureDir(dir);
  sprint.updated_at = new Date().toISOString();
  const filePath = getSprintPath(sprintId);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(sprint, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Sprint lifecycle
  initializeSprint,
  closeSprint,

  // Bidding
  placeBid,
  autoBid,
  resolveBids,

  // Commitment
  confirmCommitment,

  // Retrospective
  contributeRetro,
  recordActualDuration,

  // Query
  getSprintSummary,
  loadSprint,

  // Constants
  SPRINT_STATUS,
  SPRINT_STATE_DIR,
  MAX_BIDS_PER_TASK,
  MAX_RETRO_ENTRIES
};
