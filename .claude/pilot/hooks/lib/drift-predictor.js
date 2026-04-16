/**
 * Predictive Drift Prevention — Drift Predictor (Phase 5.6)
 *
 * Pre-action drift detection engine. Compares intended tool actions
 * against the current plan step BEFORE execution using keyword-based
 * similarity scoring (Jaccard + path matching + action-type alignment).
 *
 * Divergence levels:
 *   - aligned   (>= 0.6) — action matches plan step, no intervention
 *   - monitor   (0.3 - 0.6) — partial match, log + warn
 *   - divergent (< 0.3) — likely drift, redirect or refresh
 *
 * State files:
 *   .claude/pilot/state/drift-predictions/<sessionId>.json
 *
 * Zero external dependencies — pure keyword extraction + Jaccard similarity.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const PREDICTIONS_DIR = '.claude/pilot/state/drift-predictions';

const DEFAULT_THRESHOLDS = {
  aligned: 0.6,
  monitor: 0.3,
  divergent: 0.3  // score < this = divergent
};

// Stop words to filter from keyword extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor',
  'not', 'no', 'so', 'if', 'that', 'this', 'it', 'its', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'than', 'too', 'very', 'just', 'also', 'now', 'new',
  'use', 'file', 'code', 'add', 'update', 'make', 'get', 'set'
]);

// Tool categories for action-type alignment
const TOOL_CATEGORIES = {
  write: ['Edit', 'Write', 'Bash'],
  read: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  execute: ['Bash'],
  test: ['Bash']
};

// ============================================================================
// PATH HELPERS
// ============================================================================

function getPredictionsDir() {
  return path.join(process.cwd(), PREDICTIONS_DIR);
}

function getPredictionPath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getPredictionsDir(), `${safe}.json`);
}

function ensurePredictionsDir() {
  const dir = getPredictionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// JSON FILE OPS
// ============================================================================

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* corrupted — start fresh */ }
  return null;
}

function writeJSON(filePath, data) {
  ensurePredictionsDir();
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// POLICY LOADING
// ============================================================================

/**
 * Load drift prevention policy from policy.yaml.
 * Falls back to defaults if not configured.
 */
function loadDriftPolicy() {
  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy();
    const dp = policy?.drift_prevention;

    if (dp) {
      return {
        enabled: dp.enabled !== false,
        thresholds: { ...DEFAULT_THRESHOLDS, ...(dp.thresholds || {}) },
        excluded_tools: dp.excluded_tools || [],
        evaluation_interval_steps: dp.evaluation_interval_steps || 1,
        guardrails: dp.guardrails || {}
      };
    }
  } catch (e) { /* no policy or parse error */ }

  return {
    enabled: true,
    thresholds: { ...DEFAULT_THRESHOLDS },
    excluded_tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    evaluation_interval_steps: 1,
    guardrails: {
      warn_on_monitor: true,
      block_on_divergent: true,
      auto_refresh: true
    }
  };
}

// ============================================================================
// KEYWORD EXTRACTION
// ============================================================================

/**
 * Extract meaningful keywords from a text string.
 * Splits on whitespace and punctuation, lowercases, filters stop words.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return new Set();

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_./\\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  return new Set(words);
}

/**
 * Extract file paths from a text string.
 * Matches common file path patterns.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractPaths(text) {
  if (!text || typeof text !== 'string') return [];

  // Match file-path-like strings (contain / or \ and an extension, or start with ./)
  const pathPattern = /(?:[\w./-]+\/[\w./-]+|\.\/[\w./-]+|[\w-]+\.[\w]+)/g;
  const matches = text.match(pathPattern) || [];

  return matches.filter(m =>
    m.includes('/') || m.includes('.') && !m.startsWith('.')
  );
}

/**
 * Extract key terms from a plan step description.
 *
 * @param {object} planStep - { description, files, action, ... }
 * @returns {{ keywords: Set<string>, paths: string[], actionType: string }}
 */
function extractPlanTerms(planStep) {
  if (!planStep) {
    return { keywords: new Set(), paths: [], actionType: 'unknown' };
  }

  const description = planStep.description || planStep.title || planStep.summary || '';
  const keywords = extractKeywords(description);

  // Add file names as keywords
  const paths = planStep.files || [];
  for (const p of paths) {
    const basename = path.basename(p).replace(/\.[^.]+$/, '');
    const parts = basename.split(/[-_.]/).filter(w => w.length > 1);
    for (const part of parts) {
      keywords.add(part.toLowerCase());
    }
  }

  // Infer action type from description
  let actionType = 'unknown';
  const desc = description.toLowerCase();
  if (/\b(tests?|spec|verify|assert|expect)\b/.test(desc)) actionType = 'test';
  else if (/\b(run|execute|command|script|bash)\b/.test(desc)) actionType = 'execute';
  else if (/\b(create|write|add|implement|build)\b/.test(desc)) actionType = 'write';
  else if (/\b(read|check|inspect|review|examine)\b/.test(desc)) actionType = 'read';
  else if (/\b(edit|modify|change|update|fix|refactor)\b/.test(desc)) actionType = 'write';

  return { keywords, paths, actionType };
}

/**
 * Extract key terms from a tool action.
 *
 * @param {string} toolName - Tool name (Edit, Write, Bash, etc.)
 * @param {object} toolInput - Tool input parameters
 * @returns {{ keywords: Set<string>, paths: string[], actionType: string }}
 */
function extractToolTerms(toolName, toolInput) {
  const keywords = new Set();
  const paths = [];

  // Add tool name as keyword
  if (toolName) {
    keywords.add(toolName.toLowerCase());
  }

  if (!toolInput) {
    return { keywords, paths, actionType: categorizeToolAction(toolName) };
  }

  // Extract from file_path
  if (toolInput.file_path) {
    paths.push(toolInput.file_path);
    const basename = path.basename(toolInput.file_path).replace(/\.[^.]+$/, '');
    const parts = basename.split(/[-_.]/).filter(w => w.length > 1);
    for (const part of parts) {
      keywords.add(part.toLowerCase());
    }
    // Add directory names
    const dir = path.dirname(toolInput.file_path);
    const dirParts = dir.split(/[/\\]/).filter(w => w.length > 1);
    for (const part of dirParts.slice(-3)) { // last 3 dirs
      keywords.add(part.toLowerCase());
    }
  }

  // Extract from content snippets
  if (toolInput.new_string) {
    const contentKeywords = extractKeywords(toolInput.new_string.substring(0, 500));
    for (const kw of contentKeywords) keywords.add(kw);
  }
  if (toolInput.content) {
    const contentKeywords = extractKeywords(toolInput.content.substring(0, 500));
    for (const kw of contentKeywords) keywords.add(kw);
  }

  // Extract from Bash command
  if (toolInput.command) {
    const cmdKeywords = extractKeywords(toolInput.command);
    for (const kw of cmdKeywords) keywords.add(kw);
    const cmdPaths = extractPaths(toolInput.command);
    paths.push(...cmdPaths);
  }

  // Extract from description
  if (toolInput.description) {
    const descKeywords = extractKeywords(toolInput.description);
    for (const kw of descKeywords) keywords.add(kw);
  }

  return {
    keywords,
    paths,
    actionType: categorizeToolAction(toolName, toolInput)
  };
}

/**
 * Categorize a tool action into a high-level type.
 */
function categorizeToolAction(toolName, toolInput) {
  if (!toolName) return 'unknown';

  if (toolName === 'Edit' || toolName === 'Write') return 'write';
  if (toolName === 'Read') return 'read';
  if (toolName === 'Glob' || toolName === 'Grep') return 'read';

  if (toolName === 'Bash') {
    const cmd = (toolInput?.command || '').toLowerCase();
    if (/\b(test|vitest|jest|mocha|pytest)\b/.test(cmd)) return 'test';
    if (/\b(git\s+commit|git\s+add|git\s+push)\b/.test(cmd)) return 'write';
    if (/\b(git\s+status|git\s+log|git\s+diff)\b/.test(cmd)) return 'read';
    if (/\b(rm|mv|cp|mkdir|touch|chmod)\b/.test(cmd)) return 'write';
    if (/\b(cat|head|tail|less|find|ls|grep)\b/.test(cmd)) return 'read';
    return 'execute';
  }

  return 'unknown';
}

// ============================================================================
// SIMILARITY SCORING
// ============================================================================

/**
 * Compute Jaccard similarity between two sets.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} 0.0 to 1.0
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Compute path similarity between plan paths and tool paths.
 * Uses fuzzy matching — checks if basenames match or if paths share directories.
 *
 * @param {string[]} planPaths
 * @param {string[]} toolPaths
 * @returns {number} 0.0 to 1.0
 */
function pathSimilarity(planPaths, toolPaths) {
  if (planPaths.length === 0 && toolPaths.length === 0) return 1.0;
  if (planPaths.length === 0 || toolPaths.length === 0) return 0.0;

  let matches = 0;
  const planBasenames = planPaths.map(p => path.basename(p));
  const toolBasenames = toolPaths.map(p => path.basename(p));

  for (const tb of toolBasenames) {
    // Exact basename match
    if (planBasenames.includes(tb)) {
      matches++;
      continue;
    }
    // Check if any plan path is contained in tool path or vice versa
    for (const pp of planPaths) {
      for (const tp of toolPaths) {
        if (tp.includes(pp) || pp.includes(tp)) {
          matches += 0.5;
          break;
        }
      }
    }
  }

  return Math.min(1.0, matches / Math.max(toolBasenames.length, 1));
}

/**
 * Compute action type alignment score.
 *
 * @param {string} planActionType
 * @param {string} toolActionType
 * @returns {number} 0.0 to 1.0
 */
function actionTypeAlignment(planActionType, toolActionType) {
  if (planActionType === toolActionType) return 1.0;
  if (planActionType === 'unknown' || toolActionType === 'unknown') return 0.5;

  // Partial matches
  if (planActionType === 'write' && toolActionType === 'execute') return 0.4;
  if (planActionType === 'execute' && toolActionType === 'write') return 0.4;
  if (planActionType === 'test' && toolActionType === 'execute') return 0.7;
  if (planActionType === 'execute' && toolActionType === 'test') return 0.7;

  return 0.2;
}

// ============================================================================
// CORE PREDICTION
// ============================================================================

/**
 * Predict drift between a plan step and an intended tool action.
 *
 * @param {object} planStep - Current plan step { description, files, action }
 * @param {object} toolAction - Intended tool action { tool_name, tool_input }
 * @returns {{
 *   score: number,
 *   level: 'aligned'|'monitor'|'divergent',
 *   reasons: string[],
 *   suggestion: string|null,
 *   breakdown: { keyword: number, path: number, action_type: number }
 * }}
 */
function predictDrift(planStep, toolAction, thresholds) {
  const policy = thresholds || loadDriftPolicy().thresholds;

  if (!planStep || !toolAction) {
    return {
      score: 0.5,
      level: 'monitor',
      reasons: ['insufficient context for prediction'],
      suggestion: null,
      breakdown: { keyword: 0.5, path: 0.5, action_type: 0.5 }
    };
  }

  const planTerms = extractPlanTerms(planStep);
  const toolTerms = extractToolTerms(toolAction.tool_name, toolAction.tool_input);

  // Compute individual similarity scores
  const keywordScore = jaccardSimilarity(planTerms.keywords, toolTerms.keywords);
  const pathScore = pathSimilarity(planTerms.paths, toolTerms.paths);
  const actionScore = actionTypeAlignment(planTerms.actionType, toolTerms.actionType);

  // Weighted combination
  // Keywords: 40%, Paths: 35%, Action type: 25%
  const score = (keywordScore * 0.40) + (pathScore * 0.35) + (actionScore * 0.25);

  // Determine level
  let level;
  if (score >= policy.aligned) {
    level = 'aligned';
  } else if (score >= policy.monitor) {
    level = 'monitor';
  } else {
    level = 'divergent';
  }

  // Build reasons
  const reasons = [];
  if (keywordScore < 0.2) reasons.push('very low keyword overlap with plan step');
  else if (keywordScore < 0.4) reasons.push('limited keyword overlap with plan step');
  if (pathScore < 0.3 && planTerms.paths.length > 0) reasons.push('tool targets different files than plan');
  if (actionScore < 0.4) reasons.push(`action type mismatch (plan: ${planTerms.actionType}, tool: ${toolTerms.actionType})`);
  if (reasons.length === 0 && level === 'aligned') reasons.push('action aligns with current plan step');

  // Build suggestion
  let suggestion = null;
  if (level === 'divergent') {
    suggestion = `Current plan step: "${(planStep.description || planStep.title || '').substring(0, 100)}". ` +
      `Expected files: ${planTerms.paths.join(', ') || 'not specified'}. ` +
      `Please review the plan step before proceeding.`;
  } else if (level === 'monitor') {
    suggestion = `Partial alignment with plan step. Verify this action is intentional.`;
  }

  return {
    score: round(score),
    level,
    reasons,
    suggestion,
    breakdown: {
      keyword: round(keywordScore),
      path: round(pathScore),
      action_type: round(actionScore)
    }
  };
}

// ============================================================================
// PREDICTION HISTORY
// ============================================================================

/**
 * Record a prediction for a session.
 *
 * @param {string} sessionId
 * @param {object} prediction - Result from predictDrift
 * @param {object} context - Additional context (tool_name, plan_step_index)
 */
function recordPrediction(sessionId, prediction, context = {}) {
  ensurePredictionsDir();
  const filePath = getPredictionPath(sessionId);
  let state = readJSON(filePath) || {
    session_id: sessionId,
    predictions: [],
    stats: { total: 0, aligned: 0, monitor: 0, divergent: 0 },
    refresh_count: {},  // per plan step index
    redirect_count: 0
  };

  const entry = {
    ts: new Date().toISOString(),
    score: prediction.score,
    level: prediction.level,
    reasons: prediction.reasons,
    tool_name: context.tool_name || null,
    plan_step_index: context.plan_step_index ?? null
  };

  state.predictions.push(entry);

  // Keep last 50 predictions
  if (state.predictions.length > 50) {
    state.predictions = state.predictions.slice(-50);
  }

  // Update stats
  state.stats.total++;
  if (prediction.level === 'aligned') state.stats.aligned++;
  else if (prediction.level === 'monitor') state.stats.monitor++;
  else if (prediction.level === 'divergent') state.stats.divergent++;

  writeJSON(filePath, state);
}

/**
 * Get drift prediction history for a session.
 *
 * @param {string} sessionId
 * @returns {{ predictions: object[], stats: object }}
 */
function getDriftHistory(sessionId) {
  const state = readJSON(getPredictionPath(sessionId));
  if (!state) {
    return {
      predictions: [],
      stats: { total: 0, aligned: 0, monitor: 0, divergent: 0 }
    };
  }
  return {
    predictions: state.predictions || [],
    stats: state.stats || { total: 0, aligned: 0, monitor: 0, divergent: 0 }
  };
}

/**
 * Get the refresh count for a specific plan step in a session.
 *
 * @param {string} sessionId
 * @param {number|string} stepIndex
 * @returns {number}
 */
function getRefreshCount(sessionId, stepIndex) {
  const state = readJSON(getPredictionPath(sessionId));
  if (!state || !state.refresh_count) return 0;
  return state.refresh_count[String(stepIndex)] || 0;
}

/**
 * Increment the refresh count for a specific plan step.
 *
 * @param {string} sessionId
 * @param {number|string} stepIndex
 * @returns {number} New refresh count
 */
function incrementRefreshCount(sessionId, stepIndex) {
  ensurePredictionsDir();
  const filePath = getPredictionPath(sessionId);
  let state = readJSON(filePath) || {
    session_id: sessionId,
    predictions: [],
    stats: { total: 0, aligned: 0, monitor: 0, divergent: 0 },
    refresh_count: {},
    redirect_count: 0
  };

  const key = String(stepIndex);
  state.refresh_count[key] = (state.refresh_count[key] || 0) + 1;
  writeJSON(filePath, state);
  return state.refresh_count[key];
}

/**
 * Increment the redirect count for a session.
 *
 * @param {string} sessionId
 * @returns {number} New redirect count
 */
function incrementRedirectCount(sessionId) {
  ensurePredictionsDir();
  const filePath = getPredictionPath(sessionId);
  let state = readJSON(filePath) || {
    session_id: sessionId,
    predictions: [],
    stats: { total: 0, aligned: 0, monitor: 0, divergent: 0 },
    refresh_count: {},
    redirect_count: 0
  };

  state.redirect_count = (state.redirect_count || 0) + 1;
  writeJSON(filePath, state);
  return state.redirect_count;
}

/**
 * Get consecutive redirect count (checks recent predictions).
 *
 * @param {string} sessionId
 * @returns {number}
 */
function getConsecutiveRedirects(sessionId) {
  const state = readJSON(getPredictionPath(sessionId));
  if (!state || !state.predictions || state.predictions.length === 0) return 0;

  let count = 0;
  for (let i = state.predictions.length - 1; i >= 0; i--) {
    if (state.predictions[i].level === 'divergent') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Get overall prediction accuracy by comparing predictions to actual drift detection.
 * Returns a summary of how well predictions correlated with outcomes.
 *
 * @returns {{ total_sessions: number, avg_alignment_ratio: number }}
 */
function getAccuracy() {
  ensurePredictionsDir();
  const dir = getPredictionsDir();
  let totalSessions = 0;
  let sumAlignmentRatio = 0;

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const data = readJSON(path.join(dir, f));
      if (data && data.stats && data.stats.total > 0) {
        totalSessions++;
        sumAlignmentRatio += data.stats.aligned / data.stats.total;
      }
    }
  } catch (e) { /* directory read error */ }

  return {
    total_sessions: totalSessions,
    avg_alignment_ratio: totalSessions > 0
      ? round(sumAlignmentRatio / totalSessions)
      : 0
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function round(n) {
  return Math.round(n * 100) / 100;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core prediction
  predictDrift,

  // History
  recordPrediction,
  getDriftHistory,
  getAccuracy,

  // Refresh/redirect tracking
  getRefreshCount,
  incrementRefreshCount,
  incrementRedirectCount,
  getConsecutiveRedirects,

  // Keyword extraction (exported for testing)
  extractKeywords,
  extractPaths,
  extractPlanTerms,
  extractToolTerms,

  // Similarity scoring (exported for testing)
  jaccardSimilarity,
  pathSimilarity,
  actionTypeAlignment,
  categorizeToolAction,

  // Policy
  loadDriftPolicy,

  // Constants (for testing)
  DEFAULT_THRESHOLDS,
  PREDICTIONS_DIR,

  // Path helpers (for testing)
  getPredictionsDir,
  getPredictionPath
};
