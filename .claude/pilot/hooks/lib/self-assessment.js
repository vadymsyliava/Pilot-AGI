/**
 * Agent Self-Assessment & Growth Tracking — Phase 7.6 (Pilot AGI-m370)
 *
 * Tracks per-agent performance metrics (task completions, speeds, error rates),
 * detects skill gaps, sets growth goals, and generates periodic retrospectives
 * that feed back into the agent's SOUL.md.
 *
 * Metrics tracked:
 * - Tasks completed / failed per area
 * - Average completion time per area
 * - Error rate trends
 * - Skill scores derived from success/speed/quality
 *
 * State: .claude/pilot/state/assessments/<role>.json
 */

const fs = require('fs');
const path = require('path');

const ASSESSMENT_DIR = '.claude/pilot/state/assessments';
const MAX_TASK_HISTORY = 100;
const MAX_GOALS = 5;
const MAX_RETROSPECTIVES = 10;

// Skill score weights
const SCORE_WEIGHTS = {
  success_rate: 0.5,
  speed_factor: 0.3,
  error_rate: 0.2
};

// =============================================================================
// PATH HELPERS
// =============================================================================

function getAssessmentDir() {
  return path.join(process.cwd(), ASSESSMENT_DIR);
}

function getAssessmentPath(role) {
  return path.join(getAssessmentDir(), `${role}.json`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// ASSESSMENT STATE
// =============================================================================

function loadAssessment(role) {
  const filePath = getAssessmentPath(role);
  if (!fs.existsSync(filePath)) {
    return {
      role,
      task_history: [],
      skills: {},
      goals: [],
      retrospectives: [],
      updated_at: null
    };
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {
      role,
      task_history: [],
      skills: {},
      goals: [],
      retrospectives: [],
      updated_at: null
    };
  }
}

function saveAssessment(role, state) {
  const dir = getAssessmentDir();
  ensureDir(dir);
  state.updated_at = new Date().toISOString();
  const filePath = getAssessmentPath(role);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// TASK COMPLETION RECORDING
// =============================================================================

/**
 * Record a task completion (or failure) for metrics.
 *
 * @param {string} role - Agent role
 * @param {string} taskId - Task ID
 * @param {string} area - Skill area (e.g., 'api_design', 'styling', 'testing')
 * @param {object} outcome - { success, duration_minutes, errors, quality_score? }
 * @returns {{ success, metrics }}
 */
function recordTaskCompletion(role, taskId, area, outcome) {
  if (!role || !taskId || !area || !outcome) {
    return { success: false, error: 'role, taskId, area, and outcome required' };
  }

  const state = loadAssessment(role);

  const entry = {
    task_id: taskId,
    area,
    success: !!outcome.success,
    duration_minutes: outcome.duration_minutes || 0,
    errors: outcome.errors || 0,
    quality_score: outcome.quality_score || null,
    recorded_at: new Date().toISOString()
  };

  state.task_history.push(entry);
  if (state.task_history.length > MAX_TASK_HISTORY) {
    state.task_history = state.task_history.slice(-MAX_TASK_HISTORY);
  }

  // Update skill metrics
  updateSkillMetrics(state, area);

  // Check goal progress
  updateGoalsFromCompletion(state, area, entry);

  saveAssessment(role, state);

  return {
    success: true,
    metrics: getSkillMetrics(state, area)
  };
}

/**
 * Update skill metrics from task history for a given area.
 */
function updateSkillMetrics(state, area) {
  const areaTasks = state.task_history.filter(t => t.area === area);
  if (areaTasks.length === 0) return;

  const successes = areaTasks.filter(t => t.success).length;
  const totalErrors = areaTasks.reduce((sum, t) => sum + (t.errors || 0), 0);
  const durations = areaTasks.filter(t => t.duration_minutes > 0).map(t => t.duration_minutes);
  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;

  state.skills[area] = {
    tasks_completed: areaTasks.length,
    successes,
    success_rate: Math.round((successes / areaTasks.length) * 100),
    avg_duration_minutes: Math.round(avgDuration * 10) / 10,
    total_errors: totalErrors,
    error_rate: Math.round((totalErrors / areaTasks.length) * 100) / 100,
    last_task: areaTasks[areaTasks.length - 1].recorded_at
  };
}

function getSkillMetrics(state, area) {
  return state.skills[area] || {
    tasks_completed: 0,
    successes: 0,
    success_rate: 0,
    avg_duration_minutes: 0,
    total_errors: 0,
    error_rate: 0,
    last_task: null
  };
}

// =============================================================================
// METRICS RETRIEVAL
// =============================================================================

/**
 * Get all metrics for a role.
 */
function getMetrics(role) {
  const state = loadAssessment(role);
  return {
    role,
    total_tasks: state.task_history.length,
    skills: state.skills,
    goals: state.goals,
    updated_at: state.updated_at
  };
}

/**
 * Get skill scores — normalized 0-100 scores per skill area.
 * Score = weighted combination of success_rate, speed_factor, error_rate_inverse.
 */
function getSkillScores(role) {
  const state = loadAssessment(role);
  const scores = {};

  for (const [area, metrics] of Object.entries(state.skills)) {
    if (metrics.tasks_completed < 1) continue;

    // Success rate component: direct percentage
    const successScore = metrics.success_rate;

    // Speed factor: compare to a baseline (30 min)
    // Faster = higher score, capped at 100
    const baseline = 30;
    const speedScore = metrics.avg_duration_minutes > 0
      ? Math.min(100, Math.round((baseline / metrics.avg_duration_minutes) * 100))
      : 50;

    // Error rate inverse: lower errors = higher score
    const errorScore = Math.max(0, Math.round(100 - (metrics.error_rate * 50)));

    const total = Math.round(
      successScore * SCORE_WEIGHTS.success_rate +
      speedScore * SCORE_WEIGHTS.speed_factor +
      errorScore * SCORE_WEIGHTS.error_rate
    );

    scores[area] = {
      total: Math.min(100, total),
      success: successScore,
      speed: speedScore,
      error_avoidance: errorScore,
      tasks_completed: metrics.tasks_completed
    };
  }

  return scores;
}

// =============================================================================
// SKILL GAP DETECTION
// =============================================================================

/**
 * Detect skill gaps — areas where the agent is underperforming.
 * A gap is an area with success_rate < 70% or error_rate > 2.0.
 *
 * @param {string} role - Agent role
 * @returns {{ gaps: { area, issue, metric, suggestion }[] }}
 */
function detectSkillGaps(role) {
  const state = loadAssessment(role);
  const gaps = [];

  for (const [area, metrics] of Object.entries(state.skills)) {
    if (metrics.tasks_completed < 2) continue; // Need enough data

    if (metrics.success_rate < 70) {
      gaps.push({
        area,
        issue: 'low_success_rate',
        metric: metrics.success_rate,
        suggestion: `Improve ${area} success rate (currently ${metrics.success_rate}%)`
      });
    }

    if (metrics.error_rate > 2.0) {
      gaps.push({
        area,
        issue: 'high_error_rate',
        metric: metrics.error_rate,
        suggestion: `Reduce errors in ${area} (currently ${metrics.error_rate} per task)`
      });
    }

    if (metrics.avg_duration_minutes > 60) {
      gaps.push({
        area,
        issue: 'slow_completion',
        metric: metrics.avg_duration_minutes,
        suggestion: `Speed up ${area} tasks (currently ${metrics.avg_duration_minutes} min avg)`
      });
    }
  }

  return { gaps };
}

/**
 * Sync skill scores to the agent's SOUL.md as expertise entries.
 */
function syncSkillsToSoul(role) {
  try {
    const souls = require('./souls');
    const scores = getSkillScores(role);
    const soul = souls.loadSoul(role);
    if (!soul) return { success: false, error: 'soul not found' };

    // Update expertise section with skill scores
    const expertiseEntries = [];
    for (const [area, score] of Object.entries(scores)) {
      if (score.tasks_completed >= 3) {
        const level = score.total >= 80 ? 'strong'
          : score.total >= 60 ? 'moderate'
          : 'developing';
        expertiseEntries.push(`${area}: ${level} (score: ${score.total}, ${score.tasks_completed} tasks)`);
      }
    }

    if (expertiseEntries.length > 0) {
      soul.expertise = expertiseEntries;
      souls.writeSoul(role, soul);
    }

    return { success: true, synced: expertiseEntries.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =============================================================================
// GROWTH GOALS
// =============================================================================

/**
 * Set a growth goal for an agent.
 *
 * @param {string} role - Agent role
 * @param {string} area - Skill area
 * @param {string} target - Goal description
 * @param {number} target_metric - Target value (e.g., 90 for 90% success rate)
 */
function setGrowthGoal(role, area, target, target_metric) {
  if (!role || !area || !target) {
    return { success: false, error: 'role, area, and target required' };
  }

  const state = loadAssessment(role);

  // Check for existing goal in same area
  const existing = state.goals.findIndex(g => g.area === area && g.status === 'active');
  if (existing >= 0) {
    state.goals[existing] = {
      ...state.goals[existing],
      target,
      target_metric: target_metric || null,
      updated_at: new Date().toISOString()
    };
  } else {
    if (state.goals.filter(g => g.status === 'active').length >= MAX_GOALS) {
      return { success: false, error: `max ${MAX_GOALS} active goals` };
    }

    state.goals.push({
      area,
      target,
      target_metric: target_metric || null,
      status: 'active',
      progress: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  saveAssessment(role, state);
  return { success: true, goals: state.goals.filter(g => g.status === 'active') };
}

/**
 * Update goal progress based on a completed task.
 */
function updateGoalsFromCompletion(state, area, taskEntry) {
  for (const goal of state.goals) {
    if (goal.area !== area || goal.status !== 'active') continue;

    // Update progress based on current metrics
    const metrics = state.skills[area];
    if (!metrics) continue;

    if (goal.target_metric) {
      // Compare success_rate to target
      goal.progress = Math.min(100, Math.round((metrics.success_rate / goal.target_metric) * 100));
      if (metrics.success_rate >= goal.target_metric) {
        goal.status = 'achieved';
        goal.achieved_at = new Date().toISOString();
      }
    } else {
      // Increment progress per successful task
      if (taskEntry.success) {
        goal.progress = Math.min(100, goal.progress + 10);
      }
    }

    goal.updated_at = new Date().toISOString();
  }
}

/**
 * Manually update goal progress.
 */
function updateGoalProgress(role, area, progress) {
  const state = loadAssessment(role);
  const goal = state.goals.find(g => g.area === area && g.status === 'active');

  if (!goal) {
    return { success: false, error: 'no active goal for area' };
  }

  goal.progress = Math.min(100, Math.max(0, progress));
  if (goal.progress >= 100) {
    goal.status = 'achieved';
    goal.achieved_at = new Date().toISOString();
  }
  goal.updated_at = new Date().toISOString();

  saveAssessment(role, state);
  return { success: true, goal };
}

// =============================================================================
// RETROSPECTIVE GENERATION
// =============================================================================

/**
 * Generate a retrospective summary for the agent.
 * Analyzes recent task history to produce insights.
 *
 * @param {string} role - Agent role
 * @param {number} lookbackDays - Days to look back (default 7)
 * @returns {{ success, retrospective }}
 */
function generateRetrospective(role, lookbackDays) {
  lookbackDays = lookbackDays || 7;
  const state = loadAssessment(role);
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const recentTasks = state.task_history.filter(t => t.recorded_at >= cutoff);

  if (recentTasks.length === 0) {
    return { success: false, error: 'no recent tasks to analyze' };
  }

  // Aggregate by area
  const byArea = {};
  for (const task of recentTasks) {
    if (!byArea[task.area]) {
      byArea[task.area] = { successes: 0, failures: 0, errors: 0, durations: [] };
    }
    if (task.success) byArea[task.area].successes++;
    else byArea[task.area].failures++;
    byArea[task.area].errors += task.errors || 0;
    if (task.duration_minutes > 0) byArea[task.area].durations.push(task.duration_minutes);
  }

  // Build insights
  const strengths = [];
  const improvements = [];
  const areaStats = {};

  for (const [area, data] of Object.entries(byArea)) {
    const total = data.successes + data.failures;
    const rate = Math.round((data.successes / total) * 100);
    const avgDur = data.durations.length > 0
      ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length)
      : 0;

    areaStats[area] = { total, success_rate: rate, avg_duration: avgDur, errors: data.errors };

    if (rate >= 90) strengths.push(`${area}: ${rate}% success rate`);
    else if (rate < 70) improvements.push(`${area}: only ${rate}% success rate`);

    if (data.errors / total > 2) {
      improvements.push(`${area}: high error rate (${(data.errors / total).toFixed(1)} per task)`);
    }
  }

  // Goals progress
  const activeGoals = state.goals.filter(g => g.status === 'active');
  const achievedGoals = state.goals.filter(g =>
    g.status === 'achieved' && g.achieved_at >= cutoff
  );

  const retrospective = {
    period: `${lookbackDays} days`,
    generated_at: new Date().toISOString(),
    tasks_completed: recentTasks.length,
    overall_success_rate: recentTasks.length > 0
      ? Math.round((recentTasks.filter(t => t.success).length / recentTasks.length) * 100)
      : 0,
    area_stats: areaStats,
    strengths,
    improvements,
    active_goals: activeGoals.length,
    goals_achieved: achievedGoals.length
  };

  // Store retrospective
  state.retrospectives.push(retrospective);
  if (state.retrospectives.length > MAX_RETROSPECTIVES) {
    state.retrospectives = state.retrospectives.slice(-MAX_RETROSPECTIVES);
  }

  saveAssessment(role, state);

  // Sync to soul if significant insights
  if (strengths.length > 0 || improvements.length > 0) {
    syncRetrospectiveToSoul(role, retrospective);
  }

  return { success: true, retrospective };
}

/**
 * Write retrospective insights to soul as lessons.
 */
function syncRetrospectiveToSoul(role, retro) {
  try {
    const souls = require('./souls');

    if (retro.improvements.length > 0) {
      const lesson = `Growth area: ${retro.improvements.join('; ')}`;
      souls.recordLesson(role, lesson, 'self-assessment');
    }

    if (retro.strengths.length > 0) {
      const lesson = `Confirmed strength: ${retro.strengths.join('; ')}`;
      souls.recordLesson(role, lesson, 'self-assessment');
    }
  } catch (e) {
    // Best effort
  }
}

/**
 * Get past retrospectives.
 */
function getRetrospectives(role, limit) {
  const state = loadAssessment(role);
  const retros = state.retrospectives || [];
  return limit ? retros.slice(-limit) : retros;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Task recording
  recordTaskCompletion,

  // Metrics
  getMetrics,
  getSkillScores,

  // Skill gaps
  detectSkillGaps,
  syncSkillsToSoul,

  // Goals
  setGrowthGoal,
  updateGoalProgress,

  // Retrospective
  generateRetrospective,
  getRetrospectives,

  // State
  loadAssessment,

  // Constants
  ASSESSMENT_DIR,
  MAX_TASK_HISTORY,
  MAX_GOALS,
  MAX_RETROSPECTIVES,
  SCORE_WEIGHTS
};
