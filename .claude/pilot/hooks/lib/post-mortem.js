/**
 * Failure Post-Mortem Pipeline — Phase 7.2 (Pilot AGI-34nh)
 *
 * Auto-detects failure events, classifies root causes, extracts lessons,
 * and writes them to the agent's SOUL.md for future reference.
 *
 * Root cause categories:
 * - code_error: Syntax, type, or logic errors in generated code
 * - wrong_approach: Correct code but wrong architecture/design choice
 * - missing_context: Failure due to missing info (deps, API changes, env)
 * - bad_assumption: Agent assumed something incorrect about the codebase
 * - external_blocker: CI, network, rate limit, or infra issue
 *
 * Flow: failure detected → classify → extract lesson → write to soul → log
 */

const fs = require('fs');
const path = require('path');

const POST_MORTEM_DIR = '.claude/pilot/state/post-mortems';
const MAX_CONTEXT_LENGTH = 500;

// =============================================================================
// ROOT CAUSE CLASSIFICATION
// =============================================================================

const ROOT_CAUSES = {
  CODE_ERROR: 'code_error',
  WRONG_APPROACH: 'wrong_approach',
  MISSING_CONTEXT: 'missing_context',
  BAD_ASSUMPTION: 'bad_assumption',
  EXTERNAL_BLOCKER: 'external_blocker'
};

// Pattern library for classification
const CLASSIFICATION_PATTERNS = {
  [ROOT_CAUSES.CODE_ERROR]: [
    /SyntaxError/i,
    /TypeError/i,
    /ReferenceError/i,
    /RangeError/i,
    /cannot read propert/i,
    /is not a function/i,
    /is not defined/i,
    /unexpected token/i,
    /missing.*semicolon/i,
    /unexpected end of input/i,
    /unterminated string/i,
    /IndentationError/i,
    /NameError/i,
    /AttributeError/i
  ],
  [ROOT_CAUSES.WRONG_APPROACH]: [
    /deprecated/i,
    /not recommended/i,
    /anti.?pattern/i,
    /plan.*reject/i,
    /wrong.*approach/i,
    /should.*instead/i,
    /redesign/i,
    /architecture.*issue/i
  ],
  [ROOT_CAUSES.MISSING_CONTEXT]: [
    /module not found/i,
    /cannot find module/i,
    /no such file/i,
    /ENOENT/,
    /import.*not found/i,
    /dependency.*missing/i,
    /peer.*dependency/i,
    /version.*mismatch/i,
    /not installed/i,
    /ModuleNotFoundError/i
  ],
  [ROOT_CAUSES.BAD_ASSUMPTION]: [
    /expected.*but.*got/i,
    /assertion.*fail/i,
    /does not match/i,
    /schema.*mismatch/i,
    /type.*mismatch/i,
    /contract.*violation/i,
    /assumed/i,
    /incorrect.*assumption/i
  ],
  [ROOT_CAUSES.EXTERNAL_BLOCKER]: [
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /ECONNRESET/,
    /rate.?limit/i,
    /429/,
    /503/,
    /502/,
    /network.*error/i,
    /timeout/i,
    /ci.*fail/i,
    /pipeline.*fail/i,
    /permission.*denied/i,
    /EACCES/
  ]
};

/**
 * Classify the root cause of a failure.
 * Returns { cause, confidence, evidence }
 */
function classifyRootCause(errorContext) {
  if (!errorContext) {
    return { cause: ROOT_CAUSES.CODE_ERROR, confidence: 0.3, evidence: 'no error context' };
  }

  const text = typeof errorContext === 'string'
    ? errorContext
    : JSON.stringify(errorContext);

  const scores = {};

  for (const [cause, patterns] of Object.entries(CLASSIFICATION_PATTERNS)) {
    let matchCount = 0;
    let evidence = [];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        matchCount++;
        evidence.push(match[0]);
      }
    }

    if (matchCount > 0) {
      scores[cause] = {
        score: matchCount / patterns.length,
        matchCount,
        evidence: evidence.slice(0, 3)
      };
    }
  }

  // Find highest scoring cause
  let bestCause = ROOT_CAUSES.CODE_ERROR;
  let bestScore = 0;
  let bestEvidence = [];

  for (const [cause, data] of Object.entries(scores)) {
    if (data.score > bestScore || (data.score === bestScore && data.matchCount > scores[bestCause]?.matchCount)) {
      bestCause = cause;
      bestScore = data.score;
      bestEvidence = data.evidence;
    }
  }

  // Confidence based on match count: 2+ matches = high, 1 match = good, 0 = low
  const bestMatchCount = scores[bestCause]?.matchCount || 0;
  const confidence = bestMatchCount >= 2 ? 0.9 : bestMatchCount === 1 ? 0.75 : 0.4;

  return {
    cause: bestCause,
    confidence,
    evidence: bestEvidence.length > 0 ? bestEvidence.join(', ') : 'pattern heuristic'
  };
}

// =============================================================================
// LESSON EXTRACTION
// =============================================================================

/**
 * Extract a concise lesson from a failure diagnosis.
 * Format: "What went wrong → Why → What to do differently"
 */
function extractLesson(classification, errorContext, taskContext) {
  const { cause, evidence } = classification;
  const errorSnippet = typeof errorContext === 'string'
    ? errorContext.slice(0, 150)
    : '';

  const templates = {
    [ROOT_CAUSES.CODE_ERROR]: () => {
      const errType = evidence || 'runtime error';
      return `Code error (${errType}): Verify generated code compiles and passes type checks before committing`;
    },
    [ROOT_CAUSES.WRONG_APPROACH]: () => {
      return `Wrong approach: Research current best practices before implementing. ${errorSnippet ? 'Issue: ' + errorSnippet.slice(0, 80) : ''}`.trim();
    },
    [ROOT_CAUSES.MISSING_CONTEXT]: () => {
      const missing = evidence || 'dependency';
      return `Missing context (${missing}): Check dependencies and imports exist before using them`;
    },
    [ROOT_CAUSES.BAD_ASSUMPTION]: () => {
      return `Bad assumption: Verify API contracts and data shapes before coding against them. ${errorSnippet ? 'Expected: ' + errorSnippet.slice(0, 80) : ''}`.trim();
    },
    [ROOT_CAUSES.EXTERNAL_BLOCKER]: () => {
      const blocker = evidence || 'infrastructure';
      return `External blocker (${blocker}): Add retry logic or graceful degradation for external dependencies`;
    }
  };

  const template = templates[cause] || templates[ROOT_CAUSES.CODE_ERROR];
  return template();
}

// =============================================================================
// DEDUPLICATION
// =============================================================================

/**
 * Check if a similar lesson already exists in the soul.
 * Returns the existing lesson if found, null otherwise.
 */
function findSimilarLesson(existingLessons, newLesson) {
  if (!existingLessons || existingLessons.length === 0) return null;

  // Normalize for comparison: lowercase, remove dates/task refs
  const normalize = (text) =>
    text.toLowerCase()
      .replace(/\[[\d-]+\]/g, '')
      .replace(/\([^)]*\)/g, '')
      .trim();

  const normalizedNew = normalize(newLesson);

  for (const existing of existingLessons) {
    const existingText = existing.lesson || existing;
    const normalizedExisting = normalize(existingText);

    // Check for substring match (one contains the other)
    if (normalizedNew.includes(normalizedExisting) || normalizedExisting.includes(normalizedNew)) {
      return existing;
    }

    // Check word overlap (Jaccard similarity > 0.6)
    const wordsNew = new Set(normalizedNew.split(/\s+/).filter(w => w.length > 3));
    const wordsExisting = new Set(normalizedExisting.split(/\s+/).filter(w => w.length > 3));

    if (wordsNew.size === 0 || wordsExisting.size === 0) continue;

    const intersection = [...wordsNew].filter(w => wordsExisting.has(w)).length;
    const union = new Set([...wordsNew, ...wordsExisting]).size;
    const similarity = intersection / union;

    if (similarity > 0.5) {
      return existing;
    }
  }

  return null;
}

// =============================================================================
// POST-MORTEM TRIGGER
// =============================================================================

/**
 * Trigger a post-mortem analysis for a failed task.
 *
 * @param {string} role - Agent role
 * @param {string} taskId - Task that failed
 * @param {object} outcome - { errors: [], steps_completed, total_steps, exit_reason }
 * @returns {{ success, cause, lesson, deduplicated }}
 */
function triggerPostMortem(role, taskId, outcome) {
  if (!role || !taskId) {
    return { success: false, error: 'role and taskId required' };
  }

  const errors = outcome.errors || [];
  if (errors.length === 0 && !outcome.exit_reason) {
    return { success: false, error: 'no failure data' };
  }

  // Build error context string from errors array
  const errorContext = errors
    .map(e => typeof e === 'string' ? e : (e.error || e.message || JSON.stringify(e)))
    .join('\n')
    .slice(0, MAX_CONTEXT_LENGTH);

  // Step 1: Classify root cause
  const classification = classifyRootCause(errorContext || outcome.exit_reason);

  // Step 2: Extract lesson
  const lesson = extractLesson(classification, errorContext, {
    taskId,
    steps_completed: outcome.steps_completed,
    total_steps: outcome.total_steps
  });

  // Step 3: Check for duplicate lessons in soul
  let deduplicated = false;
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);

    if (soul) {
      const similar = findSimilarLesson(soul.lessons_learned, lesson);
      if (similar) {
        deduplicated = true;
        // Don't write duplicate — just log
      }
    }

    // Step 4: Write lesson to soul (unless duplicate)
    if (!deduplicated) {
      souls.recordLesson(role, lesson, taskId);
    }
  } catch (e) {
    // Soul module not available — still save the post-mortem record
  }

  // Step 5: Save post-mortem record
  const record = {
    task_id: taskId,
    role,
    timestamp: new Date().toISOString(),
    classification,
    lesson,
    deduplicated,
    outcome_summary: {
      error_count: errors.length,
      steps_completed: outcome.steps_completed || 0,
      total_steps: outcome.total_steps || 0,
      exit_reason: outcome.exit_reason || null
    }
  };

  savePostMortemRecord(taskId, record);

  return {
    success: true,
    cause: classification.cause,
    confidence: classification.confidence,
    lesson,
    deduplicated
  };
}

// =============================================================================
// PRE-TASK LESSON LOADER
// =============================================================================

/**
 * Load relevant lessons for a task about to start.
 * Checks agent's soul for lessons from similar failure patterns.
 *
 * @param {string} role - Agent role
 * @param {string} taskDescription - Description of the task about to start
 * @returns {string[]} Array of relevant lesson strings
 */
function getRelevantLessons(role, taskDescription) {
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (!soul || !soul.lessons_learned || soul.lessons_learned.length === 0) {
      return [];
    }

    if (!taskDescription) {
      // No task description — return last 3 lessons as general context
      return soul.lessons_learned.slice(-3).map(l => l.lesson);
    }

    // Score lessons by relevance to task description
    const taskWords = new Set(
      taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );

    const scored = soul.lessons_learned.map(entry => {
      const lessonWords = (entry.lesson || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const overlap = lessonWords.filter(w => taskWords.has(w)).length;
      return { entry, score: overlap };
    });

    // Return lessons with any relevance, plus most recent ones
    const relevant = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.entry.lesson);

    // If no relevant lessons found, return most recent ones
    if (relevant.length === 0) {
      return soul.lessons_learned.slice(-2).map(l => l.lesson);
    }

    return relevant;
  } catch (e) {
    return [];
  }
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

function getPostMortemDir() {
  return path.join(process.cwd(), POST_MORTEM_DIR);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function savePostMortemRecord(taskId, record) {
  const dir = getPostMortemDir();
  ensureDir(dir);

  const filePath = path.join(dir, `${taskId}.json`);
  const tmpPath = filePath + '.tmp.' + process.pid;

  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function loadPostMortemRecord(taskId) {
  const filePath = path.join(getPostMortemDir(), `${taskId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * List all post-mortem records.
 */
function listPostMortems() {
  const dir = getPostMortemDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const taskId = f.replace('.json', '');
      const record = loadPostMortemRecord(taskId);
      return record ? {
        task_id: taskId,
        cause: record.classification?.cause,
        lesson: record.lesson,
        timestamp: record.timestamp,
        deduplicated: record.deduplicated
      } : null;
    })
    .filter(Boolean);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core API
  triggerPostMortem,
  classifyRootCause,
  extractLesson,
  getRelevantLessons,

  // Deduplication
  findSimilarLesson,

  // State
  loadPostMortemRecord,
  listPostMortems,

  // Constants (for testing)
  ROOT_CAUSES,
  POST_MORTEM_DIR,
  MAX_CONTEXT_LENGTH
};
