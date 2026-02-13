/**
 * Opinionated Agent Personalities — Phase 7.5 (Pilot AGI-p92y)
 *
 * Opinion formation from accumulated experience. After N successful uses
 * of a pattern, agent records preference in SOUL.md with strength scoring.
 *
 * Opinion strength:
 * - weak: 2-3 successful uses
 * - moderate: 5-9 successful uses
 * - strong: 10+ with good outcomes
 *
 * Features:
 * - Opinion formation from pattern success tracking
 * - Strength scoring with evidence (task references)
 * - Opinion expression for plan comments
 * - Challenge protocol (PM or peer can challenge with counter-evidence)
 * - Evolution based on outcomes
 * - Diversity preservation (PM can check convergence)
 */

const fs = require('fs');
const path = require('path');

const OPINION_STATE_DIR = '.claude/pilot/state/opinions';

const STRENGTH = {
  NONE: 'none',
  WEAK: 'weak',         // 2-3 uses
  MODERATE: 'moderate',   // 5-9 uses
  STRONG: 'strong'       // 10+ uses
};

const STRENGTH_THRESHOLDS = {
  [STRENGTH.WEAK]: 2,
  [STRENGTH.MODERATE]: 5,
  [STRENGTH.STRONG]: 10
};

// =============================================================================
// PATH HELPERS
// =============================================================================

function getOpinionDir() {
  return path.join(process.cwd(), OPINION_STATE_DIR);
}

function getOpinionPath(role) {
  return path.join(getOpinionDir(), `${role}.json`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// OPINION STATE MANAGEMENT
// =============================================================================

/**
 * Load opinion state for a role.
 * State tracks pattern usage counts and outcomes.
 */
function loadOpinionState(role) {
  const filePath = getOpinionPath(role);
  if (!fs.existsSync(filePath)) {
    return { role, opinions: {}, updated_at: null };
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { role, opinions: {}, updated_at: null };
  }
}

function saveOpinionState(role, state) {
  const dir = getOpinionDir();
  ensureDir(dir);
  state.updated_at = new Date().toISOString();
  const filePath = getOpinionPath(role);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// OPINION FORMATION
// =============================================================================

/**
 * Record a successful pattern use. This is the primary input for
 * opinion formation — called after an agent successfully completes
 * a task using a particular pattern/tool/approach.
 *
 * @param {string} role - Agent role
 * @param {string} area - Topic area (e.g., 'testing', 'styling', 'api_design')
 * @param {string} pattern - The specific pattern used (e.g., 'Vitest', 'Tailwind')
 * @param {string} taskId - Task where the pattern was used
 * @param {boolean} success - Whether the outcome was successful
 */
function recordPatternUse(role, area, pattern, taskId, success) {
  if (!role || !area || !pattern) {
    return { success: false, error: 'role, area, and pattern required' };
  }

  const state = loadOpinionState(role);
  const key = `${area}:${pattern}`;

  if (!state.opinions[key]) {
    state.opinions[key] = {
      area,
      pattern,
      uses: 0,
      successes: 0,
      failures: 0,
      evidence: [],
      formed_at: null,
      last_used: null,
      challenged: false,
      challenge_evidence: null
    };
  }

  const opinion = state.opinions[key];
  opinion.uses++;
  if (success) {
    opinion.successes++;
  } else {
    opinion.failures++;
  }
  opinion.last_used = new Date().toISOString();

  // Track evidence (last 10 task references)
  opinion.evidence.push({
    task_id: taskId,
    success,
    ts: new Date().toISOString()
  });
  if (opinion.evidence.length > 10) {
    opinion.evidence = opinion.evidence.slice(-10);
  }

  // Check if opinion strength threshold crossed
  const oldStrength = getStrength(opinion.successes - (success ? 1 : 0));
  const newStrength = getStrength(opinion.successes);

  if (oldStrength !== newStrength && newStrength !== STRENGTH.NONE) {
    opinion.formed_at = opinion.formed_at || new Date().toISOString();

    // Write to SOUL.md as a preference
    syncOpinionToSoul(role, opinion, newStrength);
  }

  saveOpinionState(role, state);

  return {
    success: true,
    strength: newStrength,
    uses: opinion.uses,
    successes: opinion.successes
  };
}

/**
 * Determine opinion strength from success count.
 */
function getStrength(successes) {
  if (successes >= STRENGTH_THRESHOLDS[STRENGTH.STRONG]) return STRENGTH.STRONG;
  if (successes >= STRENGTH_THRESHOLDS[STRENGTH.MODERATE]) return STRENGTH.MODERATE;
  if (successes >= STRENGTH_THRESHOLDS[STRENGTH.WEAK]) return STRENGTH.WEAK;
  return STRENGTH.NONE;
}

/**
 * Sync an opinion to the agent's SOUL.md as a preference or decision rule.
 */
function syncOpinionToSoul(role, opinion, strength) {
  try {
    const souls = require('./souls');

    const successRate = opinion.uses > 0
      ? Math.round((opinion.successes / opinion.uses) * 100)
      : 0;

    // Evidence: list recent task IDs
    const recentTasks = opinion.evidence
      .filter(e => e.success)
      .slice(-3)
      .map(e => e.task_id)
      .filter(Boolean);

    const evidence = recentTasks.length > 0
      ? ` (worked in ${recentTasks.join(', ')})`
      : '';

    const confidence = strength === STRENGTH.STRONG ? 0.95
      : strength === STRENGTH.MODERATE ? 0.8
      : 0.65;

    souls.addDecisionRule(
      role,
      opinion.area,
      `prefer ${opinion.pattern}${evidence} [${strength}, ${successRate}% success rate]`,
      confidence
    );
  } catch (e) {
    // Soul not available
  }
}

// =============================================================================
// OPINION EXPRESSION
// =============================================================================

/**
 * Generate an opinion expression for use in plan comments.
 * Returns a natural-language statement about the agent's preference.
 *
 * @param {string} role - Agent role
 * @param {string} area - Topic area to express opinion about
 * @returns {string|null} Opinion expression or null if no opinion
 */
function expressOpinion(role, area) {
  const state = loadOpinionState(role);

  // Find opinions in this area
  const areaOpinions = Object.values(state.opinions)
    .filter(o => o.area === area && o.successes >= STRENGTH_THRESHOLDS[STRENGTH.WEAK])
    .sort((a, b) => b.successes - a.successes);

  if (areaOpinions.length === 0) return null;

  const top = areaOpinions[0];
  const strength = getStrength(top.successes);
  const recentTasks = top.evidence
    .filter(e => e.success)
    .slice(-3)
    .map(e => e.task_id)
    .filter(Boolean);

  const taskRef = recentTasks.length > 0
    ? ` because it worked well in ${recentTasks.join(', ')}`
    : '';

  const strengthWord = strength === STRENGTH.STRONG ? 'strongly prefer'
    : strength === STRENGTH.MODERATE ? 'prefer'
    : 'slightly prefer';

  return `I ${strengthWord} ${top.pattern} for ${area}${taskRef} (${top.successes} successful uses)`;
}

/**
 * Get all opinions for a role, sorted by strength.
 */
function getOpinions(role) {
  const state = loadOpinionState(role);

  return Object.values(state.opinions)
    .map(o => ({
      area: o.area,
      pattern: o.pattern,
      strength: getStrength(o.successes),
      uses: o.uses,
      successes: o.successes,
      failures: o.failures,
      success_rate: o.uses > 0 ? Math.round((o.successes / o.uses) * 100) : 0,
      last_used: o.last_used,
      challenged: o.challenged
    }))
    .sort((a, b) => b.successes - a.successes);
}

// =============================================================================
// CHALLENGE PROTOCOL
// =============================================================================

/**
 * Challenge an agent's opinion with counter-evidence.
 * PM or peer can provide reasons why the opinion may be wrong.
 *
 * @param {string} role - Agent role whose opinion is challenged
 * @param {string} area - Topic area
 * @param {string} pattern - Pattern being challenged
 * @param {string} counterEvidence - Why the opinion may be wrong
 * @param {string} challenger - Who is challenging (role or 'pm')
 */
function challengeOpinion(role, area, pattern, counterEvidence, challenger) {
  const state = loadOpinionState(role);
  const key = `${area}:${pattern}`;

  if (!state.opinions[key]) {
    return { success: false, error: 'opinion not found' };
  }

  const opinion = state.opinions[key];
  opinion.challenged = true;
  opinion.challenge_evidence = {
    challenger,
    evidence: counterEvidence,
    challenged_at: new Date().toISOString()
  };

  // Reduce confidence in soul
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (soul) {
      const rule = soul.decision_rules.find(r =>
        r.area === area && r.rule.includes(pattern)
      );
      if (rule) {
        rule.confidence = Math.max(0.3, (rule.confidence || 0.8) - 0.2);
        souls.writeSoul(role, soul);
      }
    }
  } catch (e) {
    // Best effort
  }

  saveOpinionState(role, state);
  return { success: true, pattern, challenged: true };
}

/**
 * Resolve a challenge — either accept (weaken opinion) or reject (maintain).
 */
function resolveChallenge(role, area, pattern, accepted) {
  const state = loadOpinionState(role);
  const key = `${area}:${pattern}`;

  if (!state.opinions[key]) {
    return { success: false, error: 'opinion not found' };
  }

  const opinion = state.opinions[key];
  opinion.challenged = false;

  if (accepted) {
    // Weaken: halve the success count
    opinion.successes = Math.floor(opinion.successes / 2);
    // Re-sync to soul with lower strength
    syncOpinionToSoul(role, opinion, getStrength(opinion.successes));
  }

  opinion.challenge_evidence = null;
  saveOpinionState(role, state);

  return {
    success: true,
    pattern,
    new_strength: getStrength(opinion.successes),
    accepted
  };
}

// =============================================================================
// DIVERSITY PRESERVATION
// =============================================================================

/**
 * Check if agents are converging on the same opinions.
 * PM uses this to ensure diversity of approaches.
 *
 * @param {string[]} roles - Roles to check
 * @returns {{ convergent_areas: { area, pattern, roles[] }[] }}
 */
function checkConvergence(roles) {
  const areaPatterns = {};

  for (const role of roles) {
    const opinions = getOpinions(role);
    for (const op of opinions) {
      if (op.strength === STRENGTH.NONE) continue;

      const key = `${op.area}:${op.pattern}`;
      if (!areaPatterns[key]) {
        areaPatterns[key] = { area: op.area, pattern: op.pattern, roles: [] };
      }
      areaPatterns[key].roles.push(role);
    }
  }

  // Find patterns held by 3+ agents
  const convergent = Object.values(areaPatterns)
    .filter(ap => ap.roles.length >= 3);

  return { convergent_areas: convergent };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core
  recordPatternUse,
  getOpinions,
  expressOpinion,
  getStrength,

  // Challenge
  challengeOpinion,
  resolveChallenge,

  // Diversity
  checkConvergence,

  // State
  loadOpinionState,

  // Constants
  STRENGTH,
  STRENGTH_THRESHOLDS,
  OPINION_STATE_DIR
};
