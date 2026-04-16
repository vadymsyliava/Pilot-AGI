/**
 * Peer Review Protocol — Phase 7.7 (Pilot AGI-xpc3)
 *
 * PM assigns reviewer based on expertise match. Review generates structured
 * feedback (correctness, style, coverage, soul alignment). Both reviewer
 * and author update SOUL.md from review outcomes. Lightweight mode for
 * small changes.
 *
 * State: .claude/pilot/state/reviews/<taskId>.json
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

const REVIEWS_DIR = '.claude/pilot/state/reviews';
const LIGHTWEIGHT_THRESHOLD = 50; // lines changed
const MAX_DIFF_CHARS = 8000;
const REVIEW_CHECKLIST = ['correctness', 'style', 'test_coverage', 'soul_alignment'];
const MAX_STORED_REVIEWS = 50;

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

function getReviewPath(taskId, projectRoot) {
  const root = projectRoot || process.cwd();
  return path.join(root, REVIEWS_DIR, taskId + '.json');
}

function countDiffLines(diff) {
  if (!diff) return 0;
  const lines = diff.split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) count++;
    if (line.startsWith('-') && !line.startsWith('---')) count++;
  }
  return count;
}

// =============================================================================
// REVIEWER SELECTION
// =============================================================================

/**
 * Select the best reviewer for a task based on expertise match.
 * Uses agent-registry capabilities and SOUL.md expertise data.
 *
 * @param {string} authorRole - The role of the task author
 * @param {string[]} taskDomains - Domains the task touches (e.g., ['api', 'database'])
 * @param {object} [opts] - { projectRoot, excludeRoles }
 * @returns {{ reviewer: string, score: number, reason: string } | null}
 */
function selectReviewer(authorRole, taskDomains, opts) {
  const { projectRoot, excludeRoles = [] } = opts || {};
  const root = projectRoot || process.cwd();

  if (!authorRole || !taskDomains || taskDomains.length === 0) {
    return null;
  }

  // Load agent registry
  const registryPath = path.join(root, '.claude/pilot/agent-registry.json');
  let agents = {};
  try {
    const registry = readJSON(registryPath);
    agents = (registry && registry.agents) || {};
  } catch (e) {
    return null;
  }

  // Load souls for expertise matching
  let souls;
  try {
    souls = require('./souls');
  } catch (e) {
    souls = null;
  }

  const candidates = [];
  const domainsLower = taskDomains.map(d => d.toLowerCase());

  for (const [role, agent] of Object.entries(agents)) {
    // Don't review your own work
    if (role === authorRole) continue;
    // Don't use excluded roles
    if (excludeRoles.includes(role)) continue;
    // PM doesn't do peer review (it orchestrates)
    if (role === 'pm') continue;

    let score = 0;
    const reasons = [];

    // Score based on capability overlap with task domains
    const caps = (agent.capabilities || []).map(c => c.toLowerCase());
    for (const domain of domainsLower) {
      if (caps.some(c => c.includes(domain) || domain.includes(c))) {
        score += 2;
        reasons.push('capability:' + domain);
      }
    }

    // Score based on soul expertise
    if (souls) {
      const soul = souls.loadSoul(role);
      if (soul && soul.expertise) {
        for (const domain of domainsLower) {
          if (soul.expertise.some(e => e.toLowerCase().includes(domain))) {
            score += 1;
            reasons.push('expertise:' + domain);
          }
        }
      }
    }

    // Cross-domain review bonus: different role reviewing gives fresh perspective
    if (score > 0) {
      score += 1;
      reasons.push('cross-domain');
    }

    if (score > 0) {
      candidates.push({ reviewer: role, score, reason: reasons.join(', ') });
    }
  }

  if (candidates.length === 0) {
    // Fallback: use 'review' role if it exists
    if (agents.review) {
      return { reviewer: 'review', score: 1, reason: 'fallback-reviewer' };
    }
    return null;
  }

  // Return highest scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// =============================================================================
// REVIEW EXECUTION
// =============================================================================

/**
 * Determine if a change is lightweight (small diff).
 * @param {string} diff
 * @returns {boolean}
 */
function isLightweight(diff) {
  return countDiffLines(diff) <= LIGHTWEIGHT_THRESHOLD;
}

/**
 * Build a review checklist from diff and context.
 *
 * @param {string} diff - The git diff to review
 * @param {object} context - { taskId, taskDescription, authorRole, reviewerRole }
 * @param {object} [opts] - { projectRoot, lightweight }
 * @returns {object} Review checklist with scores per category
 */
function buildReviewChecklist(diff, context, opts) {
  const { projectRoot } = opts || {};
  const lightweight = opts?.lightweight ?? isLightweight(diff);

  const truncatedDiff = diff.substring(0, MAX_DIFF_CHARS);
  const checklist = {};

  // Load reviewer's soul for alignment checks
  let reviewerPrefs = [];
  let reviewerRules = [];
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(context.reviewerRole);
    if (soul) {
      reviewerPrefs = soul.preferences || [];
      reviewerRules = (soul.decision_rules || []).map(r => r.rule);
    }
  } catch (e) { /* souls unavailable */ }

  // Analyze diff for each checklist category
  const diffLines = truncatedDiff.split('\n');
  const addedLines = diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removedLines = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---'));

  // 1. Correctness — basic heuristic checks
  const correctnessIssues = [];
  for (const line of addedLines) {
    const content = line.slice(1);
    if (content.includes('TODO') || content.includes('FIXME')) {
      correctnessIssues.push('Contains TODO/FIXME: ' + content.trim().substring(0, 60));
    }
    if (content.includes('console.log') && !context.taskDescription?.includes('debug')) {
      correctnessIssues.push('Debug console.log left in: ' + content.trim().substring(0, 60));
    }
    if (content.match(/catch\s*\([^)]*\)\s*\{\s*\}/)) {
      correctnessIssues.push('Empty catch block detected');
    }
  }
  checklist.correctness = {
    score: correctnessIssues.length === 0 ? 'pass' : 'warning',
    issues: correctnessIssues
  };

  // 2. Style — check consistency patterns
  const styleIssues = [];
  const hasTrailingSpaces = addedLines.some(l => l.match(/\s+$/));
  if (hasTrailingSpaces) {
    styleIssues.push('Trailing whitespace detected');
  }
  const hasMixedQuotes = addedLines.some(l => l.includes("'")) && addedLines.some(l => l.includes('"'));
  if (hasMixedQuotes && addedLines.length > 5) {
    // Only flag for substantial changes
    styleIssues.push('Mixed quote styles in new code');
  }
  checklist.style = {
    score: styleIssues.length === 0 ? 'pass' : 'info',
    issues: styleIssues
  };

  // 3. Test coverage — check if tests were added/modified
  const testIssues = [];
  const hasTestChanges = diffLines.some(l =>
    l.includes('.test.') || l.includes('.spec.') || l.includes('__tests__')
  );
  if (!lightweight && !hasTestChanges && addedLines.length > 20) {
    testIssues.push('No test changes for substantial code addition');
  }
  checklist.test_coverage = {
    score: testIssues.length === 0 ? 'pass' : 'warning',
    issues: testIssues
  };

  // 4. Soul alignment — check against reviewer's preferences/rules
  const alignmentIssues = [];
  if (reviewerPrefs.length > 0 || reviewerRules.length > 0) {
    // Basic keyword matching for preference alignment
    const diffText = addedLines.join('\n').toLowerCase();
    for (const rule of reviewerRules) {
      const ruleLower = rule.toLowerCase();
      // Check for negations (avoid X, don't use Y)
      const avoidMatch = ruleLower.match(/avoid\s+(\w+)|don'?t\s+use\s+(\w+)|never\s+use\s+(\w+)/);
      if (avoidMatch) {
        const avoidWord = (avoidMatch[1] || avoidMatch[2] || avoidMatch[3]);
        if (diffText.includes(avoidWord)) {
          alignmentIssues.push('Possible conflict with rule: ' + rule);
        }
      }
    }
  }
  checklist.soul_alignment = {
    score: alignmentIssues.length === 0 ? 'pass' : 'info',
    issues: alignmentIssues
  };

  return checklist;
}

/**
 * Execute a full peer review.
 *
 * @param {string} taskId - Task being reviewed
 * @param {string} diff - Git diff of the work
 * @param {object} context - { authorRole, reviewerRole, taskDescription, branchName }
 * @param {object} [opts] - { projectRoot }
 * @returns {{ approved: boolean, checklist: object, summary: string, lightweight: boolean }}
 */
function executeReview(taskId, diff, context, opts) {
  const { projectRoot } = opts || {};

  if (!taskId || !diff || !context?.authorRole || !context?.reviewerRole) {
    return { approved: false, error: 'taskId, diff, context.authorRole, context.reviewerRole required' };
  }

  const lightweight = isLightweight(diff);
  const checklist = buildReviewChecklist(diff, {
    taskId,
    taskDescription: context.taskDescription,
    authorRole: context.authorRole,
    reviewerRole: context.reviewerRole
  }, { projectRoot, lightweight });

  // Determine approval based on checklist
  const hasBlockers = Object.values(checklist).some(c => c.score === 'fail');
  const warnings = Object.values(checklist).filter(c => c.score === 'warning');
  const allIssues = Object.values(checklist).flatMap(c => c.issues);

  let approved;
  let summary;

  if (hasBlockers) {
    approved = false;
    summary = 'Review blocked: critical issues found';
  } else if (warnings.length > 1) {
    approved = false;
    summary = 'Review flagged: ' + warnings.length + ' warnings need attention';
  } else {
    approved = true;
    summary = lightweight ? 'Lightweight review: approved' : 'Review passed';
    if (warnings.length === 1) {
      summary += ' with minor concerns';
    }
  }

  // Save review state
  const review = {
    task_id: taskId,
    author: context.authorRole,
    reviewer: context.reviewerRole,
    approved,
    lightweight,
    checklist,
    summary,
    issues: allIssues,
    branch: context.branchName || null,
    reviewed_at: new Date().toISOString()
  };

  writeJSON(getReviewPath(taskId, projectRoot), review);

  return {
    approved,
    checklist,
    summary,
    lightweight,
    issues: allIssues
  };
}

// =============================================================================
// FEEDBACK & LEARNING
// =============================================================================

/**
 * Generate structured feedback from a review.
 *
 * @param {string} taskId
 * @param {object} [opts] - { projectRoot }
 * @returns {object | null}
 */
function getReviewFeedback(taskId, opts) {
  const { projectRoot } = opts || {};
  const reviewPath = getReviewPath(taskId, projectRoot);
  const review = readJSON(reviewPath);
  if (!review) return null;

  const feedback = {
    task_id: taskId,
    reviewer: review.reviewer,
    approved: review.approved,
    summary: review.summary,
    comments: []
  };

  for (const [category, result] of Object.entries(review.checklist)) {
    if (result.issues.length > 0) {
      feedback.comments.push({
        category,
        severity: result.score, // pass, info, warning, fail
        issues: result.issues
      });
    }
  }

  return feedback;
}

/**
 * Record review outcomes in both reviewer and author SOUL.md.
 * Reviewer gains review expertise; author learns from feedback.
 *
 * @param {string} taskId
 * @param {object} [opts] - { projectRoot }
 * @returns {{ author_updated: boolean, reviewer_updated: boolean }}
 */
function learnFromReview(taskId, opts) {
  const { projectRoot } = opts || {};
  const reviewPath = getReviewPath(taskId, projectRoot);
  const review = readJSON(reviewPath);
  if (!review) return { author_updated: false, reviewer_updated: false };

  let authorUpdated = false;
  let reviewerUpdated = false;

  try {
    const souls = require('./souls');

    // Author learns from review issues
    if (review.issues && review.issues.length > 0) {
      const lessonText = 'Review feedback on ' + taskId + ': ' + review.issues[0];
      const result = souls.recordLesson(review.author, lessonText, taskId);
      if (result && result.success) authorUpdated = true;
    }

    // Reviewer gains expertise in review
    const reviewerSoul = souls.loadSoul(review.reviewer);
    if (reviewerSoul) {
      const reviewArea = 'code review for ' + review.author + ' work';
      if (!reviewerSoul.expertise.includes(reviewArea)) {
        // Only add if not already there and not too many
        if (reviewerSoul.expertise.length < 10) {
          reviewerSoul.expertise.push(reviewArea);
          souls.writeSoul(review.reviewer, reviewerSoul);
          reviewerUpdated = true;
        }
      }
    }
  } catch (e) {
    // souls module unavailable
  }

  // Update review state with learning outcome
  review.learning = { author_updated: authorUpdated, reviewer_updated: reviewerUpdated };
  review.learning_at = new Date().toISOString();
  writeJSON(reviewPath, review);

  return { author_updated: authorUpdated, reviewer_updated: reviewerUpdated };
}

// =============================================================================
// REVIEW HISTORY
// =============================================================================

/**
 * Get review history for a role (as author or reviewer).
 *
 * @param {string} role
 * @param {object} [opts] - { projectRoot, limit, asReviewer }
 * @returns {Array}
 */
function getReviewHistory(role, opts) {
  const { projectRoot, limit = 10, asReviewer = false } = opts || {};
  const root = projectRoot || process.cwd();
  const reviewsDir = path.join(root, REVIEWS_DIR);

  if (!fs.existsSync(reviewsDir)) return [];

  const files = fs.readdirSync(reviewsDir).filter(f => f.endsWith('.json'));
  const reviews = [];

  for (const file of files) {
    const review = readJSON(path.join(reviewsDir, file));
    if (!review) continue;

    const match = asReviewer
      ? review.reviewer === role
      : review.author === role;

    if (match) {
      reviews.push({
        task_id: review.task_id,
        approved: review.approved,
        summary: review.summary,
        reviewer: review.reviewer,
        author: review.author,
        reviewed_at: review.reviewed_at
      });
    }
  }

  reviews.sort((a, b) => (b.reviewed_at || '').localeCompare(a.reviewed_at || ''));
  return reviews.slice(0, limit);
}

/**
 * Get review statistics for a role.
 *
 * @param {string} role
 * @param {object} [opts] - { projectRoot }
 * @returns {object}
 */
function getReviewStats(role, opts) {
  const { projectRoot } = opts || {};
  const root = projectRoot || process.cwd();
  const reviewsDir = path.join(root, REVIEWS_DIR);

  if (!fs.existsSync(reviewsDir)) {
    return { role, as_author: { total: 0 }, as_reviewer: { total: 0 } };
  }

  const files = fs.readdirSync(reviewsDir).filter(f => f.endsWith('.json'));
  const asAuthor = { total: 0, approved: 0, rejected: 0 };
  const asReviewer = { total: 0, approved: 0, rejected: 0 };

  for (const file of files) {
    const review = readJSON(path.join(reviewsDir, file));
    if (!review) continue;

    if (review.author === role) {
      asAuthor.total++;
      if (review.approved) asAuthor.approved++;
      else asAuthor.rejected++;
    }
    if (review.reviewer === role) {
      asReviewer.total++;
      if (review.approved) asReviewer.approved++;
      else asReviewer.rejected++;
    }
  }

  return { role, as_author: asAuthor, as_reviewer: asReviewer };
}

// =============================================================================
// PM INTEGRATION
// =============================================================================

/**
 * Request a peer review for a completed task. Called by PM loop.
 *
 * @param {string} taskId
 * @param {string} authorRole
 * @param {string} diff
 * @param {object} [opts] - { projectRoot, taskDescription, branchName }
 * @returns {object} Review result
 */
function requestReview(taskId, authorRole, diff, opts) {
  const { projectRoot, taskDescription, branchName } = opts || {};

  if (!taskId || !authorRole || !diff) {
    return { error: 'taskId, authorRole, and diff required' };
  }

  // Determine task domains from diff file paths
  const taskDomains = extractDomainsFromDiff(diff);

  // Select reviewer
  const selection = selectReviewer(authorRole, taskDomains.length > 0 ? taskDomains : ['general'], {
    projectRoot
  });

  if (!selection) {
    return {
      approved: true,
      summary: 'No reviewer available — auto-approved',
      reviewer: null,
      skipped: true
    };
  }

  // Execute review
  const result = executeReview(taskId, diff, {
    authorRole,
    reviewerRole: selection.reviewer,
    taskDescription,
    branchName
  }, { projectRoot });

  result.reviewer = selection.reviewer;
  result.reviewer_match_score = selection.score;
  result.reviewer_match_reason = selection.reason;

  return result;
}

/**
 * Extract domain keywords from diff file paths.
 * @param {string} diff
 * @returns {string[]}
 */
function extractDomainsFromDiff(diff) {
  const domains = new Set();
  const lines = diff.split('\n');

  for (const line of lines) {
    // Match diff file headers: --- a/path or +++ b/path or diff --git a/path b/path
    const fileMatch = line.match(/^(?:---|\+\+\+|diff --git)\s+[ab]\/(.+)/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1].toLowerCase();

    // Infer domains from path
    if (filePath.includes('api') || filePath.includes('route') || filePath.includes('endpoint')) {
      domains.add('api_design');
    }
    if (filePath.includes('test') || filePath.includes('spec')) {
      domains.add('testing');
    }
    if (filePath.includes('component') || filePath.includes('page') || filePath.includes('.tsx') || filePath.includes('.jsx')) {
      domains.add('component_creation');
    }
    if (filePath.includes('style') || filePath.includes('.css') || filePath.includes('.scss')) {
      domains.add('styling');
    }
    if (filePath.includes('database') || filePath.includes('migration') || filePath.includes('schema')) {
      domains.add('database_operations');
    }
    if (filePath.includes('security') || filePath.includes('auth')) {
      domains.add('security_audit');
    }
    if (filePath.includes('hook') || filePath.includes('middleware')) {
      domains.add('api_design');
    }
  }

  return Array.from(domains);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Reviewer selection
  selectReviewer,

  // Review execution
  isLightweight,
  buildReviewChecklist,
  executeReview,

  // Feedback & learning
  getReviewFeedback,
  learnFromReview,

  // History
  getReviewHistory,
  getReviewStats,

  // PM integration
  requestReview,

  // Internal (for testing)
  extractDomainsFromDiff,
  countDiffLines,

  // Constants (for testing)
  _REVIEWS_DIR: REVIEWS_DIR,
  _LIGHTWEIGHT_THRESHOLD: LIGHTWEIGHT_THRESHOLD,
  _MAX_DIFF_CHARS: MAX_DIFF_CHARS,
  _REVIEW_CHECKLIST: REVIEW_CHECKLIST
};
