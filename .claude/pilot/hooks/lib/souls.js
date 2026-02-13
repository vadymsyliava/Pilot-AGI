/**
 * Agent Soul Module — Phase 7.1 (Pilot AGI-tfro)
 *
 * Per-agent identity files (SOUL.md) that persist personality traits,
 * expertise, learned preferences, and decision rules across sessions.
 *
 * Storage: .claude/pilot/souls/<role>.md (Markdown with YAML front matter)
 * Budget: max 4KB per soul with automatic consolidation
 *
 * Concurrency model:
 * - Per-role ownership (agents only write their own soul)
 * - PM can calibrate any soul
 * - Atomic writes via write-to-tmp-then-rename
 */

const fs = require('fs');
const path = require('path');

const SOULS_DIR = '.claude/pilot/souls';
const MAX_SOUL_BYTES = 4096;
const MAX_LESSONS = 20;
const MAX_DECISION_RULES = 15;

// =============================================================================
// PATH HELPERS
// =============================================================================

function getSoulsDir() {
  return path.join(process.cwd(), SOULS_DIR);
}

function getSoulPath(role) {
  return path.join(getSoulsDir(), `${role}.md`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// ATOMIC WRITE
// =============================================================================

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// SOUL SCHEMA — DEFAULT TRAITS PER ROLE
// =============================================================================

const DEFAULT_TRAITS = {
  frontend: {
    risk_tolerance: 'moderate',
    verbosity: 'concise',
    testing_preference: 'component_tests',
    refactoring_appetite: 'moderate',
    decision_style: 'user-centric, iterative'
  },
  backend: {
    risk_tolerance: 'conservative',
    verbosity: 'concise',
    testing_preference: 'integration_tests',
    refactoring_appetite: 'moderate',
    decision_style: 'contract-first, defensive'
  },
  testing: {
    risk_tolerance: 'conservative',
    verbosity: 'detailed',
    testing_preference: 'comprehensive',
    refactoring_appetite: 'low',
    decision_style: 'coverage-driven, thorough'
  },
  security: {
    risk_tolerance: 'conservative',
    verbosity: 'detailed',
    testing_preference: 'adversarial',
    refactoring_appetite: 'low',
    decision_style: 'threat-model-first, paranoid'
  },
  pm: {
    risk_tolerance: 'moderate',
    verbosity: 'concise',
    testing_preference: 'acceptance_tests',
    refactoring_appetite: 'moderate',
    decision_style: 'priority-driven, delegation-focused'
  },
  design: {
    risk_tolerance: 'moderate',
    verbosity: 'concise',
    testing_preference: 'visual_regression',
    refactoring_appetite: 'moderate',
    decision_style: 'consistency-driven, system-thinking'
  },
  review: {
    risk_tolerance: 'conservative',
    verbosity: 'detailed',
    testing_preference: 'comprehensive',
    refactoring_appetite: 'high',
    decision_style: 'pattern-focused, quality-gate'
  },
  infra: {
    risk_tolerance: 'conservative',
    verbosity: 'concise',
    testing_preference: 'smoke_tests',
    refactoring_appetite: 'low',
    decision_style: 'reliability-first, incremental'
  }
};

// =============================================================================
// PARSE / SERIALIZE SOUL.md
// =============================================================================

/**
 * Parse a SOUL.md file into structured data.
 * Format: YAML front matter (---) + Markdown body sections.
 */
function parseSoul(content) {
  const soul = {
    meta: {},
    traits: {},
    expertise: [],
    preferences: [],
    lessons_learned: [],
    decision_rules: []
  };

  if (!content || !content.trim()) return soul;

  // Extract YAML front matter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const yaml = fmMatch[1];
    for (const line of yaml.split('\n')) {
      const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (kv) {
        const key = kv[1].trim();
        const val = kv[2].trim();
        if (['risk_tolerance', 'verbosity', 'testing_preference', 'refactoring_appetite', 'decision_style'].includes(key)) {
          soul.traits[key] = val;
        } else {
          soul.meta[key] = val;
        }
      }
    }
  }

  // Extract sections from Markdown body
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const sections = body.split(/^## /m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.split('\n');
    const heading = lines[0].trim().toLowerCase();
    const items = lines.slice(1)
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim());

    if (heading === 'expertise') {
      soul.expertise = items;
    } else if (heading === 'preferences') {
      soul.preferences = items;
    } else if (heading === 'lessons learned') {
      soul.lessons_learned = items.map(parseLesson);
    } else if (heading === 'decision rules') {
      soul.decision_rules = items.map(parseDecisionRule);
    }
  }

  return soul;
}

function parseLesson(line) {
  // Format: [YYYY-MM-DD] (task-id) lesson text
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(?:\(([^)]+)\)\s*)?(.+)$/);
  if (match) {
    return { date: match[1], task_id: match[2] || null, lesson: match[3] };
  }
  return { date: null, task_id: null, lesson: line };
}

function parseDecisionRule(line) {
  // Format: [area] rule text (confidence: N.N)
  const match = line.match(/^\[([^\]]+)\]\s*(.+?)(?:\s*\(confidence:\s*([\d.]+)\))?$/);
  if (match) {
    return { area: match[1], rule: match[2].trim(), confidence: parseFloat(match[3] || '1.0') };
  }
  return { area: 'general', rule: line, confidence: 1.0 };
}

/**
 * Serialize structured soul data back to SOUL.md format.
 */
function serializeSoul(soul) {
  const lines = [];

  // YAML front matter
  lines.push('---');
  lines.push(`role: ${soul.meta.role || 'unknown'}`);
  if (soul.meta.created) lines.push(`created: ${soul.meta.created}`);
  lines.push(`updated: ${new Date().toISOString().split('T')[0]}`);
  // Version: increment on updates, keep on initial write
  const currentVersion = parseInt(soul.meta.version || '0', 10);
  lines.push(`version: ${currentVersion || 1}`);

  // Traits in front matter
  for (const [key, val] of Object.entries(soul.traits || {})) {
    lines.push(`${key}: ${val}`);
  }
  lines.push('---');
  lines.push('');

  // Expertise section
  if (soul.expertise && soul.expertise.length > 0) {
    lines.push('## Expertise');
    for (const item of soul.expertise) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Preferences section
  if (soul.preferences && soul.preferences.length > 0) {
    lines.push('## Preferences');
    for (const item of soul.preferences) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Lessons learned section
  if (soul.lessons_learned && soul.lessons_learned.length > 0) {
    lines.push('## Lessons Learned');
    for (const entry of soul.lessons_learned) {
      const date = entry.date || new Date().toISOString().split('T')[0];
      const taskRef = entry.task_id ? ` (${entry.task_id})` : '';
      lines.push(`- [${date}]${taskRef} ${entry.lesson}`);
    }
    lines.push('');
  }

  // Decision rules section
  if (soul.decision_rules && soul.decision_rules.length > 0) {
    lines.push('## Decision Rules');
    for (const entry of soul.decision_rules) {
      const conf = entry.confidence !== undefined && entry.confidence !== 1.0
        ? ` (confidence: ${entry.confidence.toFixed(1)})`
        : '';
      lines.push(`- [${entry.area}] ${entry.rule}${conf}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// CORE API
// =============================================================================

/**
 * Check if a soul file exists for the given role.
 */
function soulExists(role) {
  return fs.existsSync(getSoulPath(role));
}

/**
 * Load and parse the soul for a given agent role.
 * Returns null if soul doesn't exist.
 */
function loadSoul(role) {
  const soulPath = getSoulPath(role);
  if (!fs.existsSync(soulPath)) return null;

  try {
    const content = fs.readFileSync(soulPath, 'utf8');
    return parseSoul(content);
  } catch (e) {
    return null;
  }
}

/**
 * Write a complete soul object to disk.
 * Bumps version unless opts.keepVersion is true (used by initializeSoul).
 */
function writeSoul(role, soul, opts) {
  if (!(opts && opts.keepVersion)) {
    soul.meta.version = String(parseInt(soul.meta.version || '0', 10) + 1);
  }
  const content = serializeSoul(soul);
  atomicWrite(getSoulPath(role), content);
  return { success: true, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Initialize a default soul for a role from agent-registry capabilities.
 * Only creates if soul doesn't already exist.
 * Returns the soul data.
 */
function initializeSoul(role) {
  if (soulExists(role)) {
    return loadSoul(role);
  }

  // Load capabilities from agent registry
  let capabilities = [];
  let description = '';
  try {
    const registryPath = path.join(process.cwd(), '.claude/pilot/agent-registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const agent = registry.agents && registry.agents[role];
      if (agent) {
        capabilities = agent.capabilities || [];
        description = agent.description || '';
      }
    }
  } catch (e) {
    // Registry not available, use empty capabilities
  }

  const traits = DEFAULT_TRAITS[role] || {
    risk_tolerance: 'moderate',
    verbosity: 'concise',
    testing_preference: 'unit_tests',
    refactoring_appetite: 'moderate',
    decision_style: 'pragmatic'
  };

  const soul = {
    meta: {
      role,
      created: new Date().toISOString().split('T')[0],
      version: '1'
    },
    traits,
    expertise: capabilities.map(c => c.replace(/_/g, ' ')),
    preferences: description ? [`Core focus: ${description}`] : [],
    lessons_learned: [],
    decision_rules: []
  };

  writeSoul(role, soul, { keepVersion: true });
  return soul;
}

/**
 * Update a specific section of the soul.
 * @param {string} role - Agent role
 * @param {string} section - One of: traits, expertise, preferences, lessons_learned, decision_rules
 * @param {*} content - New content for the section (merged, not replaced)
 */
function updateSection(role, section, content) {
  const soul = loadSoul(role);
  if (!soul) {
    return { success: false, error: `Soul not found for role: ${role}` };
  }

  if (section === 'traits' && typeof content === 'object') {
    Object.assign(soul.traits, content);
  } else if (section === 'expertise' && Array.isArray(content)) {
    // Merge unique expertise items
    const existing = new Set(soul.expertise);
    for (const item of content) {
      existing.add(item);
    }
    soul.expertise = [...existing];
  } else if (section === 'preferences' && Array.isArray(content)) {
    const existing = new Set(soul.preferences);
    for (const item of content) {
      existing.add(item);
    }
    soul.preferences = [...existing];
  } else if (section === 'lessons_learned' && Array.isArray(content)) {
    soul.lessons_learned.push(...content);
    // Enforce max lessons
    if (soul.lessons_learned.length > MAX_LESSONS) {
      soul.lessons_learned = soul.lessons_learned.slice(-MAX_LESSONS);
    }
  } else if (section === 'decision_rules' && Array.isArray(content)) {
    soul.decision_rules.push(...content);
    if (soul.decision_rules.length > MAX_DECISION_RULES) {
      soul.decision_rules = soul.decision_rules.slice(-MAX_DECISION_RULES);
    }
  } else {
    return { success: false, error: `Invalid section or content type: ${section}` };
  }

  return writeSoul(role, soul);
}

/**
 * Record a lesson learned for an agent role.
 */
function recordLesson(role, lesson, taskId) {
  const soul = loadSoul(role) || initializeSoul(role);

  soul.lessons_learned.push({
    date: new Date().toISOString().split('T')[0],
    task_id: taskId || null,
    lesson
  });

  // Enforce max lessons
  if (soul.lessons_learned.length > MAX_LESSONS) {
    soul.lessons_learned = soul.lessons_learned.slice(-MAX_LESSONS);
  }

  return writeSoul(role, soul);
}

/**
 * Add a decision rule for an agent role.
 */
function addDecisionRule(role, area, rule, confidence) {
  const soul = loadSoul(role) || initializeSoul(role);

  // Check for duplicate rules in same area
  const existing = soul.decision_rules.findIndex(
    r => r.area === area && r.rule === rule
  );

  if (existing >= 0) {
    // Reinforce existing rule (boost confidence)
    soul.decision_rules[existing].confidence = Math.min(
      1.0,
      (soul.decision_rules[existing].confidence || 0.8) + 0.1
    );
  } else {
    soul.decision_rules.push({
      area,
      rule,
      confidence: confidence !== undefined ? confidence : 0.8
    });
  }

  // Enforce max rules
  if (soul.decision_rules.length > MAX_DECISION_RULES) {
    // Remove lowest confidence rules
    soul.decision_rules.sort((a, b) => (b.confidence || 1) - (a.confidence || 1));
    soul.decision_rules = soul.decision_rules.slice(0, MAX_DECISION_RULES);
  }

  return writeSoul(role, soul);
}

/**
 * Get the byte size of a soul file.
 */
function getSoulSize(role) {
  const soulPath = getSoulPath(role);
  if (!fs.existsSync(soulPath)) return 0;
  return fs.statSync(soulPath).size;
}

/**
 * Consolidate a soul that exceeds the size budget.
 * Trims oldest lessons, lowest-confidence rules, and deduplicates.
 */
function consolidateSoul(role) {
  const soul = loadSoul(role);
  if (!soul) return { success: false, error: 'Soul not found' };

  // Trim lessons to half max
  if (soul.lessons_learned.length > MAX_LESSONS / 2) {
    soul.lessons_learned = soul.lessons_learned.slice(-(MAX_LESSONS / 2));
  }

  // Trim low-confidence rules
  if (soul.decision_rules.length > MAX_DECISION_RULES / 2) {
    soul.decision_rules.sort((a, b) => (b.confidence || 1) - (a.confidence || 1));
    soul.decision_rules = soul.decision_rules.slice(0, Math.ceil(MAX_DECISION_RULES / 2));
  }

  // Deduplicate expertise
  soul.expertise = [...new Set(soul.expertise)];

  // Deduplicate preferences
  soul.preferences = [...new Set(soul.preferences)];

  const result = writeSoul(role, soul);

  // Check if still over budget
  const size = getSoulSize(role);
  if (size > MAX_SOUL_BYTES) {
    // Aggressive trim — cut lessons to 5, rules to 5
    soul.lessons_learned = soul.lessons_learned.slice(-5);
    soul.decision_rules = soul.decision_rules.slice(0, 5);
    return writeSoul(role, soul);
  }

  return result;
}

// =============================================================================
// PM SOUL EDITOR API
// =============================================================================

/**
 * PM calibration — update traits or add rules to any agent's soul.
 */
function calibrateSoul(role, updates) {
  const soul = loadSoul(role) || initializeSoul(role);

  if (updates.traits) {
    Object.assign(soul.traits, updates.traits);
  }
  if (updates.expertise) {
    const existing = new Set(soul.expertise);
    for (const item of updates.expertise) existing.add(item);
    soul.expertise = [...existing];
  }
  if (updates.preferences) {
    const existing = new Set(soul.preferences);
    for (const item of updates.preferences) existing.add(item);
    soul.preferences = [...existing];
  }
  if (updates.decision_rules) {
    soul.decision_rules.push(...updates.decision_rules);
  }

  return writeSoul(role, soul);
}

/**
 * Reset a soul to defaults (preserves lessons and rules).
 * Pass { hard: true } to wipe everything.
 */
function resetSoul(role, opts) {
  if (opts && opts.hard) {
    const soulPath = getSoulPath(role);
    if (fs.existsSync(soulPath)) {
      fs.unlinkSync(soulPath);
    }
    return initializeSoul(role);
  }

  // Soft reset — restore default traits/expertise, keep lessons/rules
  const existing = loadSoul(role);
  const fresh = initializeSoul(role);

  if (existing) {
    fresh.lessons_learned = existing.lessons_learned || [];
    fresh.decision_rules = existing.decision_rules || [];
    // Keep custom preferences (append to defaults)
    const defaults = new Set(fresh.preferences);
    for (const p of (existing.preferences || [])) {
      defaults.add(p);
    }
    fresh.preferences = [...defaults];
  }

  // Need to delete first since initializeSoul won't overwrite
  const soulPath = getSoulPath(role);
  if (fs.existsSync(soulPath)) fs.unlinkSync(soulPath);
  writeSoul(role, fresh, { keepVersion: true });
  return fresh;
}

/**
 * List all existing soul files.
 */
function listSouls() {
  const dir = getSoulsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const role = f.replace('.md', '');
      const soul = loadSoul(role);
      return {
        role,
        size: getSoulSize(role),
        version: soul ? parseInt(soul.meta.version || '1', 10) : 0,
        lessons: soul ? soul.lessons_learned.length : 0,
        rules: soul ? soul.decision_rules.length : 0
      };
    });
}

// =============================================================================
// CONTEXT LOADER (for session-start hook)
// =============================================================================

/**
 * Load soul context for injection into agent prompt.
 * Returns a compact representation suitable for context injection.
 */
function loadSoulContext(role) {
  const soul = loadSoul(role);
  if (!soul) return null;

  const ctx = {
    role: soul.meta.role,
    traits: soul.traits
  };

  if (soul.expertise.length > 0) {
    ctx.expertise = soul.expertise;
  }
  if (soul.preferences.length > 0) {
    ctx.preferences = soul.preferences;
  }
  if (soul.lessons_learned.length > 0) {
    // Only inject last 5 lessons for token efficiency
    ctx.recent_lessons = soul.lessons_learned.slice(-5).map(l => l.lesson);
  }
  if (soul.decision_rules.length > 0) {
    // Only inject high-confidence rules
    ctx.active_rules = soul.decision_rules
      .filter(r => (r.confidence || 1) >= 0.6)
      .map(r => `[${r.area}] ${r.rule}`);
  }

  return ctx;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Core API
  loadSoul,
  writeSoul,
  initializeSoul,
  soulExists,
  updateSection,
  recordLesson,
  addDecisionRule,
  getSoulSize,
  consolidateSoul,

  // PM editor API
  calibrateSoul,
  resetSoul,
  listSouls,

  // Context loader
  loadSoulContext,

  // Parse/serialize (for testing)
  parseSoul,
  serializeSoul,

  // Constants (for testing)
  SOULS_DIR,
  MAX_SOUL_BYTES,
  MAX_LESSONS,
  MAX_DECISION_RULES,
  DEFAULT_TRAITS
};
