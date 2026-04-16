/**
 * Decomposition Outcome Tracker (Phase 5.5)
 *
 * Tracks predicted vs actual results for every task decomposition.
 * Feeds into the pattern library and adaptive sizing system.
 *
 * State files:
 *   .claude/pilot/state/decomposition-outcomes/<parentTaskId>.json — per-task outcomes
 *   .claude/pilot/state/decomposition-outcomes/sizing.json          — adaptive sizing state
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const OUTCOMES_DIR = '.claude/pilot/state/decomposition-outcomes';
const SIZING_FILE = 'sizing.json';

// ============================================================================
// PATH HELPERS
// ============================================================================

function getOutcomesDir() {
  return path.join(process.cwd(), OUTCOMES_DIR);
}

function getOutcomePath(taskId) {
  const safe = taskId.replace(/\s+/g, '_');
  return path.join(getOutcomesDir(), `${safe}.json`);
}

function getSizingPath() {
  return path.join(getOutcomesDir(), SIZING_FILE);
}

function ensureDir() {
  const dir = getOutcomesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// ATOMIC FILE OPS
// ============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    // Corrupted file — start fresh
  }
  return null;
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ============================================================================
// PREDICTION RECORDING
// ============================================================================

/**
 * Record a decomposition prediction when PM decomposes a task.
 *
 * @param {string} taskId - Parent task ID
 * @param {object} prediction - {
 *   subtask_count: number,
 *   subtask_ids: string[],
 *   complexity_per_subtask: object,  // { subtaskId: 'S'|'M'|'L' }
 *   task_type: string,               // "feature"|"bugfix"|"refactor"|"test"|"docs"|"infra"
 *   domain: string,                  // domain classification
 *   template_used: string|null       // pattern library template ID if used
 * }
 */
function recordPrediction(taskId, prediction) {
  if (!taskId || !prediction) return;

  ensureDir();
  const filePath = getOutcomePath(taskId);
  const state = readJSON(filePath) || {
    task_id: taskId,
    created_at: new Date().toISOString()
  };

  state.prediction = {
    subtask_count: prediction.subtask_count || 0,
    subtask_ids: prediction.subtask_ids || [],
    complexity_per_subtask: prediction.complexity_per_subtask || {},
    task_type: prediction.task_type || 'unknown',
    domain: prediction.domain || 'unknown',
    template_used: prediction.template_used || null,
    recorded_at: new Date().toISOString()
  };

  state.outcomes = state.outcomes || {};
  state.updated_at = new Date().toISOString();

  writeJSON(filePath, state);
}

// ============================================================================
// OUTCOME RECORDING
// ============================================================================

/**
 * Record the outcome of a completed subtask.
 *
 * @param {string} taskId - Parent task ID
 * @param {string} subtaskId - The subtask that completed
 * @param {object} outcome - {
 *   actual_complexity: 'S'|'M'|'L',
 *   duration_ms: number,
 *   commit_count: number,
 *   respawn_count: number,
 *   stuck: boolean,
 *   reworked: boolean
 * }
 */
function recordOutcome(taskId, subtaskId, outcome) {
  if (!taskId || !subtaskId) return;

  ensureDir();
  const filePath = getOutcomePath(taskId);
  const state = readJSON(filePath) || {
    task_id: taskId,
    prediction: null,
    outcomes: {},
    created_at: new Date().toISOString()
  };

  state.outcomes[subtaskId] = {
    actual_complexity: outcome.actual_complexity || 'M',
    duration_ms: outcome.duration_ms || 0,
    commit_count: outcome.commit_count || 0,
    respawn_count: outcome.respawn_count || 0,
    stuck: outcome.stuck || false,
    reworked: outcome.reworked || false,
    completed_at: new Date().toISOString()
  };

  state.updated_at = new Date().toISOString();
  writeJSON(filePath, state);
}

/**
 * Record that subtasks were added or removed after initial decomposition.
 *
 * @param {string} taskId - Parent task ID
 * @param {string[]} addedIds - Subtask IDs added after decomposition
 * @param {string[]} removedIds - Subtask IDs removed/skipped
 */
function recordSubtaskChanges(taskId, addedIds, removedIds) {
  if (!taskId) return;

  ensureDir();
  const filePath = getOutcomePath(taskId);
  const state = readJSON(filePath);
  if (!state) return;

  state.subtask_changes = {
    added: addedIds || [],
    removed: removedIds || [],
    recorded_at: new Date().toISOString()
  };

  state.updated_at = new Date().toISOString();
  writeJSON(filePath, state);
}

// ============================================================================
// ACCURACY CALCULATION
// ============================================================================

/**
 * Calculate accuracy metrics for a single task's decomposition.
 *
 * @param {string} taskId - Parent task ID
 * @returns {{ task_id: string, predicted_count: number, actual_count: number,
 *             count_accuracy: number, complexity_accuracy: number,
 *             stuck_count: number, rework_count: number, overall_accuracy: number } | null}
 */
function getAccuracy(taskId) {
  const filePath = getOutcomePath(taskId);
  const state = readJSON(filePath);
  if (!state || !state.prediction) return null;

  const predicted = state.prediction;
  const outcomes = state.outcomes || {};
  const changes = state.subtask_changes || { added: [], removed: [] };

  const predictedCount = predicted.subtask_count;
  const actualCount = Object.keys(outcomes).length + (changes.added || []).length;
  const completedOutcomes = Object.values(outcomes);

  // Count accuracy: 1.0 if exact, degrades linearly
  const countDiff = Math.abs(predictedCount - actualCount);
  const countAccuracy = predictedCount > 0
    ? Math.max(0, 1 - countDiff / predictedCount)
    : (actualCount === 0 ? 1 : 0);

  // Complexity accuracy: compare predicted vs actual per subtask
  let complexityMatches = 0;
  let complexityTotal = 0;
  for (const [stId, outcome] of Object.entries(outcomes)) {
    const predictedComplexity = predicted.complexity_per_subtask[stId];
    if (predictedComplexity) {
      complexityTotal++;
      if (predictedComplexity === outcome.actual_complexity) {
        complexityMatches++;
      }
    }
  }
  const complexityAccuracy = complexityTotal > 0
    ? complexityMatches / complexityTotal
    : 1; // No predictions to compare = no error

  const stuckCount = completedOutcomes.filter(o => o.stuck).length;
  const reworkCount = completedOutcomes.filter(o => o.reworked).length;

  // Overall accuracy: weighted combination
  const overallAccuracy = (countAccuracy * 0.5 + complexityAccuracy * 0.5);

  return {
    task_id: taskId,
    predicted_count: predictedCount,
    actual_count: actualCount,
    count_accuracy: Math.round(countAccuracy * 100) / 100,
    complexity_accuracy: Math.round(complexityAccuracy * 100) / 100,
    stuck_count: stuckCount,
    rework_count: reworkCount,
    overall_accuracy: Math.round(overallAccuracy * 100) / 100
  };
}

/**
 * Get historical accuracy across multiple decompositions.
 *
 * @param {number} [limit=20] - Max recent outcomes to include
 * @returns {{ count: number, avg_count_accuracy: number, avg_complexity_accuracy: number,
 *             avg_overall_accuracy: number, total_stuck: number, total_rework: number,
 *             by_type: object }}
 */
function getHistoricalAccuracy(limit) {
  if (limit === undefined) limit = 20;

  const dir = getOutcomesDir();
  if (!fs.existsSync(dir)) {
    return {
      count: 0, avg_count_accuracy: 0, avg_complexity_accuracy: 0,
      avg_overall_accuracy: 0, total_stuck: 0, total_rework: 0, by_type: {}
    };
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== SIZING_FILE)
    .sort()
    .slice(-limit);

  const accuracies = [];
  const byType = {};
  let totalStuck = 0;
  let totalRework = 0;

  for (const f of files) {
    const state = readJSON(path.join(dir, f));
    if (!state || !state.prediction) continue;

    const taskId = state.task_id;
    const acc = getAccuracy(taskId);
    if (!acc) continue;

    accuracies.push(acc);
    totalStuck += acc.stuck_count;
    totalRework += acc.rework_count;

    const taskType = state.prediction.task_type || 'unknown';
    if (!byType[taskType]) {
      byType[taskType] = { count: 0, total_accuracy: 0 };
    }
    byType[taskType].count++;
    byType[taskType].total_accuracy += acc.overall_accuracy;
  }

  const count = accuracies.length;
  const avgCount = count > 0
    ? accuracies.reduce((s, a) => s + a.count_accuracy, 0) / count : 0;
  const avgComplexity = count > 0
    ? accuracies.reduce((s, a) => s + a.complexity_accuracy, 0) / count : 0;
  const avgOverall = count > 0
    ? accuracies.reduce((s, a) => s + a.overall_accuracy, 0) / count : 0;

  // Average per-type
  for (const t of Object.keys(byType)) {
    byType[t].avg_accuracy = byType[t].count > 0
      ? Math.round((byType[t].total_accuracy / byType[t].count) * 100) / 100
      : 0;
  }

  return {
    count,
    avg_count_accuracy: Math.round(avgCount * 100) / 100,
    avg_complexity_accuracy: Math.round(avgComplexity * 100) / 100,
    avg_overall_accuracy: Math.round(avgOverall * 100) / 100,
    total_stuck: totalStuck,
    total_rework: totalRework,
    by_type: byType
  };
}

// ============================================================================
// ADAPTIVE SIZING
// ============================================================================

/**
 * Get adaptive sizing multiplier for a task type.
 * Based on historical over/under-estimation patterns.
 *
 * @param {string} taskType - "feature"|"bugfix"|"refactor"|"test"|"docs"|"infra"
 * @returns {{ multiplier: number, confidence: number, sample_size: number }}
 */
function getAdaptiveSizing(taskType) {
  const sizingPath = getSizingPath();
  const sizing = readJSON(sizingPath) || { types: {} };
  const entry = sizing.types[taskType];

  if (!entry || entry.sample_size < 3) {
    return { multiplier: 1.0, confidence: 0, sample_size: entry?.sample_size || 0 };
  }

  return {
    multiplier: Math.round(entry.multiplier * 100) / 100,
    confidence: Math.round(entry.confidence * 100) / 100,
    sample_size: entry.sample_size
  };
}

/**
 * Update adaptive sizing based on a completed decomposition outcome.
 *
 * @param {string} taskType - Task type
 * @param {number} predictedCount - Predicted subtask count
 * @param {number} actualCount - Actual subtask count (including added/removed)
 */
function updateAdaptiveSizing(taskType, predictedCount, actualCount) {
  if (!taskType || predictedCount <= 0) return;

  ensureDir();
  const sizingPath = getSizingPath();
  const sizing = readJSON(sizingPath) || { types: {}, updated_at: null };

  if (!sizing.types[taskType]) {
    sizing.types[taskType] = {
      multiplier: 1.0,
      total_predicted: 0,
      total_actual: 0,
      sample_size: 0,
      confidence: 0
    };
  }

  const entry = sizing.types[taskType];
  entry.total_predicted += predictedCount;
  entry.total_actual += actualCount;
  entry.sample_size += 1;

  // Calculate multiplier: actual / predicted (EMA with 0.3 weight for new data)
  const ratio = actualCount / predictedCount;
  const alpha = 0.3;
  entry.multiplier = entry.sample_size === 1
    ? ratio
    : entry.multiplier * (1 - alpha) + ratio * alpha;

  // Clamp multiplier to reasonable range
  entry.multiplier = Math.max(0.5, Math.min(2.0, entry.multiplier));

  // Confidence grows with sample size (asymptotic to 1.0)
  entry.confidence = 1 - 1 / (1 + entry.sample_size * 0.2);

  sizing.updated_at = new Date().toISOString();
  writeJSON(sizingPath, sizing);
}

// ============================================================================
// RETRIEVAL
// ============================================================================

/**
 * Get the full outcome state for a task.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
function getOutcome(taskId) {
  return readJSON(getOutcomePath(taskId));
}

/**
 * Check if all predicted subtasks have outcomes (decomposition complete).
 *
 * @param {string} taskId
 * @returns {boolean}
 */
function isDecompositionComplete(taskId) {
  const state = readJSON(getOutcomePath(taskId));
  if (!state || !state.prediction) return false;

  const predictedIds = state.prediction.subtask_ids || [];
  const completedIds = Object.keys(state.outcomes || {});

  return predictedIds.length > 0 && predictedIds.every(id => completedIds.includes(id));
}

// ============================================================================
// CLEANUP (for testing)
// ============================================================================

function resetOutcome(taskId) {
  const p = getOutcomePath(taskId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

function resetSizing() {
  const p = getSizingPath();
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Recording
  recordPrediction,
  recordOutcome,
  recordSubtaskChanges,

  // Accuracy
  getAccuracy,
  getHistoricalAccuracy,

  // Adaptive sizing
  getAdaptiveSizing,
  updateAdaptiveSizing,

  // Retrieval
  getOutcome,
  isDecompositionComplete,

  // Testing helpers
  resetOutcome,
  resetSizing,
  getOutcomePath,
  getSizingPath,

  // Constants
  OUTCOMES_DIR,
  SIZING_FILE
};
