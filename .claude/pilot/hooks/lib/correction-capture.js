/**
 * User Correction Capture — Phase 7.3 (Pilot AGI-h4yi)
 *
 * Detects user corrections (plan rejections, manual edits after agent edits,
 * explicit "no, do X instead" prompts), classifies them, extracts behavioral
 * rules, and stores them in the agent's SOUL.md.
 *
 * Correction types:
 * - style_preference: Formatting, naming conventions, code style
 * - technical_preference: Library choices, patterns, architectures
 * - project_convention: Project-specific rules and standards
 * - factual_correction: Wrong assumption about API, behavior, etc.
 *
 * Integration points:
 * - user-prompt-submit.js: Detects explicit corrections in prompts
 * - post-tool-use.js: Detects manual edits after agent edits (via git diff)
 */

const fs = require('fs');
const path = require('path');

const CORRECTION_LOG_DIR = '.claude/pilot/state/corrections';
const CONFIDENCE_DECAY_RATE = 0.05; // Per 30 days without reinforcement
const MIN_CONFIDENCE = 0.3;

// =============================================================================
// CORRECTION TYPES
// =============================================================================

const CORRECTION_TYPES = {
  STYLE_PREFERENCE: 'style_preference',
  TECHNICAL_PREFERENCE: 'technical_preference',
  PROJECT_CONVENTION: 'project_convention',
  FACTUAL_CORRECTION: 'factual_correction'
};

// =============================================================================
// CORRECTION DETECTION — PROMPT ANALYSIS
// =============================================================================

/**
 * Correction indicator patterns in user prompts.
 * Each pattern maps to a correction type with extraction hints.
 */
const PROMPT_PATTERNS = {
  explicit_correction: [
    /\b(?:no|nope),?\s+(?:use|do|try|prefer|always|never)\b/i,
    /\b(?:don't|dont|do not)\s+(?:use|do|add|create|make)\b/i,
    /\b(?:always|never)\s+(?:use|do|add|prefer)\b/i,
    /\binstead\s+(?:use|of|do)\b/i,
    /\brather\s+than\b/i,
    /\bprefer\s+(?:to\s+)?(?:use|have|keep)\b/i,
    /\bi\s+prefer\b/i,
    /\bswitch\s+to\b/i,
    /\bchange\s+(?:this|that|it)\s+to\b/i,
    /\bthat's\s+(?:wrong|incorrect|not right)\b/i,
    /\bactually,?\s+(?:use|do|it should|we)\b/i
  ],
  style_indicators: [
    /\b(?:tabs|spaces|indent|semicolon|quotes|naming|camelCase|snake_case|kebab-case)\b/i,
    /\b(?:formatting|prettier|eslint|lint)\b/i,
    /\b(?:single quotes|double quotes)\b/i,
    /\b(?:2 spaces|4 spaces|tab)\b/i
  ],
  technical_indicators: [
    /\b(?:use|prefer|switch to)\s+(?:zod|yup|joi|express|fastify|prisma|drizzle|mongoose)\b/i,
    /\b(?:use|prefer|switch to)\s+(?:vitest|jest|mocha|playwright|cypress)\b/i,
    /\b(?:use|prefer|switch to)\s+(?:tailwind|css modules|styled-components|emotion)\b/i,
    /\b(?:use|prefer|switch to)\s+(?:zustand|redux|jotai|recoil|context)\b/i,
    /\b(?:typescript|javascript|ts|js)\s+(?:not|instead|over)\b/i,
    /\b(?:async\/await|promises|callbacks)\b/i,
    /\b(?:functional|class|oop|procedural)\b/i
  ],
  convention_indicators: [
    /\b(?:in this project|our convention|we always|our standard|project rule)\b/i,
    /\b(?:file structure|folder structure|directory structure)\b/i,
    /\b(?:naming convention|import order|export style)\b/i,
    /\b(?:our team|company standard|codebase convention)\b/i
  ]
};

/**
 * Detect if a user prompt contains a correction.
 * Returns null if no correction detected, or correction data.
 */
function detectPromptCorrection(prompt) {
  if (!prompt || prompt.length < 10) return null;

  const trimmed = prompt.trim();

  // Skip obvious non-corrections
  if (trimmed.endsWith('?') && !trimmed.toLowerCase().includes('why not')) return null;
  if (/^\//.test(trimmed)) return null; // Commands
  if (trimmed.length < 15) return null; // Too short

  // Check for explicit correction patterns
  let isCorrection = false;
  for (const pattern of PROMPT_PATTERNS.explicit_correction) {
    if (pattern.test(trimmed)) {
      isCorrection = true;
      break;
    }
  }

  if (!isCorrection) return null;

  // Classify the correction type
  const type = classifyCorrection(trimmed);

  // Extract the rule
  const rule = extractRule(trimmed);

  if (!rule) return null;

  return {
    type,
    rule,
    source: 'prompt',
    raw: trimmed.slice(0, 200),
    detected_at: new Date().toISOString()
  };
}

/**
 * Classify a correction into one of the CORRECTION_TYPES.
 */
function classifyCorrection(text) {
  const lower = text.toLowerCase();

  // Check style indicators
  for (const pattern of PROMPT_PATTERNS.style_indicators) {
    if (pattern.test(lower)) return CORRECTION_TYPES.STYLE_PREFERENCE;
  }

  // Check convention indicators
  for (const pattern of PROMPT_PATTERNS.convention_indicators) {
    if (pattern.test(lower)) return CORRECTION_TYPES.PROJECT_CONVENTION;
  }

  // Check technical indicators
  for (const pattern of PROMPT_PATTERNS.technical_indicators) {
    if (pattern.test(lower)) return CORRECTION_TYPES.TECHNICAL_PREFERENCE;
  }

  // Default: factual correction
  return CORRECTION_TYPES.FACTUAL_CORRECTION;
}

/**
 * Extract a behavioral rule from a correction prompt.
 * Returns a concise rule string.
 */
function extractRule(text) {
  const lower = text.toLowerCase();

  // Pattern: "always use X" or "never use Y"
  const alwaysMatch = text.match(/\b(always|never)\s+(use|do|add|prefer|include)\s+(.{5,60}?)(?:\.|$|,|\s+(?:in|for|when|because))/i);
  if (alwaysMatch) {
    const action = alwaysMatch[1].toLowerCase();
    const verb = alwaysMatch[2].toLowerCase();
    const target = alwaysMatch[3].trim();
    return `${action} ${verb} ${target}`;
  }

  // Pattern: "use X instead of Y"
  const insteadMatch = text.match(/\buse\s+(.{3,40}?)\s+instead\s+of\s+(.{3,40}?)(?:\.|$|,)/i);
  if (insteadMatch) {
    return `prefer ${insteadMatch[1].trim()} over ${insteadMatch[2].trim()}`;
  }

  // Pattern: "prefer X over Y"
  const preferMatch = text.match(/\bprefer\s+(.{3,40}?)\s+(?:over|to|instead of)\s+(.{3,40}?)(?:\.|$|,)/i);
  if (preferMatch) {
    return `prefer ${preferMatch[1].trim()} over ${preferMatch[2].trim()}`;
  }

  // Pattern: "switch to X" or "change to X"
  const switchMatch = text.match(/\b(?:switch|change)\s+to\s+(.{3,60}?)(?:\.|$|,)/i);
  if (switchMatch) {
    return `use ${switchMatch[1].trim()}`;
  }

  // Pattern: "don't use X"
  const dontMatch = text.match(/\b(?:don't|dont|do not)\s+(use|add|create|do)\s+(.{3,60}?)(?:\.|$|,)/i);
  if (dontMatch) {
    return `never ${dontMatch[1]} ${dontMatch[2].trim()}`;
  }

  // Fallback: extract the imperative part
  const imperative = text.match(/(?:^|\.\s+)((?:use|prefer|always|never|switch|change|add|remove)\s+.{5,60}?)(?:\.|$)/i);
  if (imperative) {
    return imperative[1].trim().toLowerCase();
  }

  return null;
}

// =============================================================================
// RULE APPLICATION
// =============================================================================

/**
 * Map correction types to SOUL.md decision rule areas.
 */
function correctionTypeToArea(type) {
  const mapping = {
    [CORRECTION_TYPES.STYLE_PREFERENCE]: 'style',
    [CORRECTION_TYPES.TECHNICAL_PREFERENCE]: 'technology',
    [CORRECTION_TYPES.PROJECT_CONVENTION]: 'convention',
    [CORRECTION_TYPES.FACTUAL_CORRECTION]: 'general'
  };
  return mapping[type] || 'general';
}

/**
 * Apply a detected correction to the agent's soul.
 * Writes a decision rule to SOUL.md.
 */
function applyCorrection(role, correction) {
  if (!role || !correction || !correction.rule) {
    return { success: false, error: 'role and correction with rule required' };
  }

  try {
    const souls = require('./souls');
    const area = correctionTypeToArea(correction.type);
    const result = souls.addDecisionRule(role, area, correction.rule, 0.8);

    // Log the correction
    logCorrection(role, correction);

    return { success: true, area, rule: correction.rule, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =============================================================================
// CONFIDENCE DECAY
// =============================================================================

/**
 * Apply confidence decay to decision rules that haven't been reinforced.
 * Rules lose CONFIDENCE_DECAY_RATE per 30-day period since last reinforcement.
 * Rules below MIN_CONFIDENCE are removed.
 *
 * @param {string} role - Agent role to decay
 * @returns {{ decayed: number, removed: number }}
 */
function applyConfidenceDecay(role) {
  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (!soul || !soul.decision_rules || soul.decision_rules.length === 0) {
      return { decayed: 0, removed: 0 };
    }

    const now = Date.now();
    let decayed = 0;
    let removed = 0;

    // Load correction log to find last reinforcement dates
    const log = loadCorrectionLog(role);
    const ruleLastSeen = {};
    for (const entry of log) {
      if (entry.rule) {
        ruleLastSeen[entry.rule] = new Date(entry.detected_at || entry.timestamp).getTime();
      }
    }

    const updatedRules = [];
    for (const rule of soul.decision_rules) {
      const lastSeen = ruleLastSeen[rule.rule] || now;
      const daysSinceReinforcement = (now - lastSeen) / (1000 * 60 * 60 * 24);
      const periods = Math.floor(daysSinceReinforcement / 30);

      if (periods > 0) {
        const newConfidence = (rule.confidence || 1.0) - (CONFIDENCE_DECAY_RATE * periods);
        if (newConfidence < MIN_CONFIDENCE) {
          removed++;
          continue; // Skip — effectively removes the rule
        }
        rule.confidence = Math.round(newConfidence * 100) / 100;
        decayed++;
      }
      updatedRules.push(rule);
    }

    if (decayed > 0 || removed > 0) {
      soul.decision_rules = updatedRules;
      souls.writeSoul(role, soul);
    }

    return { decayed, removed };
  } catch (e) {
    return { decayed: 0, removed: 0, error: e.message };
  }
}

// =============================================================================
// CORRECTION LOG
// =============================================================================

function getCorrectionLogDir() {
  return path.join(process.cwd(), CORRECTION_LOG_DIR);
}

function getCorrectionLogPath(role) {
  return path.join(getCorrectionLogDir(), `${role}.jsonl`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function logCorrection(role, correction) {
  const dir = getCorrectionLogDir();
  ensureDir(dir);

  const logPath = getCorrectionLogPath(role);
  const entry = {
    ...correction,
    timestamp: new Date().toISOString()
  };

  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function loadCorrectionLog(role) {
  const logPath = getCorrectionLogPath(role);
  if (!fs.existsSync(logPath)) return [];

  try {
    return fs.readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

/**
 * Get correction stats for an agent role.
 */
function getCorrectionStats(role) {
  const log = loadCorrectionLog(role);

  const byType = {};
  for (const entry of log) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
  }

  return {
    total: log.length,
    by_type: byType,
    last_correction: log.length > 0 ? log[log.length - 1].timestamp : null
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Detection
  detectPromptCorrection,
  classifyCorrection,
  extractRule,

  // Application
  applyCorrection,
  correctionTypeToArea,

  // Decay
  applyConfidenceDecay,

  // Logging
  logCorrection,
  loadCorrectionLog,
  getCorrectionStats,

  // Constants
  CORRECTION_TYPES,
  CONFIDENCE_DECAY_RATE,
  MIN_CONFIDENCE
};
