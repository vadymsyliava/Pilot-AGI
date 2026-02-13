/**
 * Soul Persistence & Cross-Session Identity — Phase 7.9 (Pilot AGI-nvn8)
 *
 * Soul survives context resets, session restarts, and optionally project
 * boundaries. Periodic backups to ~/.pilot-agi/souls/ for cross-project
 * identity. Soul merge combines global + project-specific learnings.
 *
 * Features:
 * - Backup/restore soul to/from global directory
 * - Cross-project merge (global + local)
 * - Soul diff (track evolution via snapshots)
 * - Format versioning for backward compatibility
 * - PM soul reset API (clear specific sections)
 *
 * Global backup: ~/.pilot-agi/souls/<role>.json
 * Snapshots: .claude/pilot/state/soul-snapshots/<role>/<timestamp>.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let _globalSoulsDir = path.join(os.homedir(), '.pilot-agi', 'souls');
const SNAPSHOT_DIR = '.claude/pilot/state/soul-snapshots';
const SOUL_FORMAT_VERSION = 1;
const MAX_SNAPSHOTS = 20;

// =============================================================================
// PATH HELPERS
// =============================================================================

function getGlobalSoulsDir() {
  return _globalSoulsDir;
}

function setGlobalSoulsDir(dir) {
  _globalSoulsDir = dir;
}

function getGlobalSoulPath(role) {
  return path.join(getGlobalSoulsDir(), `${role}.json`);
}

function getSnapshotDir(role) {
  return path.join(process.cwd(), SNAPSHOT_DIR, role);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// BACKUP & RESTORE
// =============================================================================

/**
 * Backup a soul to the global directory (~/.pilot-agi/souls/).
 * Creates a snapshot before backup for diff tracking.
 *
 * @param {string} role - Agent role
 * @returns {{ success, backed_up_at, global_path }}
 */
function backupSoul(role) {
  if (!role) return { success: false, error: 'role required' };

  try {
    const souls = require('./souls');
    const soul = souls.loadSoul(role);
    if (!soul) return { success: false, error: 'soul not found' };

    // Create snapshot first
    takeSnapshot(role, soul);

    // Backup to global
    ensureDir(getGlobalSoulsDir());
    const globalPath = getGlobalSoulPath(role);

    const backup = {
      format_version: SOUL_FORMAT_VERSION,
      role,
      project: getProjectId(),
      backed_up_at: new Date().toISOString(),
      soul
    };

    const tmpPath = globalPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(backup, null, 2), 'utf8');
    fs.renameSync(tmpPath, globalPath);

    return {
      success: true,
      backed_up_at: backup.backed_up_at,
      global_path: globalPath
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Restore a soul from the global directory.
 * Merges global soul with any existing local soul.
 *
 * @param {string} role - Agent role
 * @param {object} opts - { overwrite? } If true, replaces local soul entirely
 * @returns {{ success, merged, source }}
 */
function restoreSoul(role, opts) {
  if (!role) return { success: false, error: 'role required' };
  opts = opts || {};

  const globalPath = getGlobalSoulPath(role);
  if (!fs.existsSync(globalPath)) {
    return { success: false, error: 'no global backup found' };
  }

  try {
    const backup = JSON.parse(fs.readFileSync(globalPath, 'utf8'));

    // Version check
    if (backup.format_version > SOUL_FORMAT_VERSION) {
      return { success: false, error: `incompatible format version: ${backup.format_version}` };
    }

    const souls = require('./souls');

    if (opts.overwrite) {
      souls.writeSoul(role, backup.soul);
      return { success: true, merged: false, source: 'global' };
    }

    // Merge global with local
    const localSoul = souls.loadSoul(role);
    if (!localSoul || !localSoul.meta || !localSoul.meta.role) {
      // No local soul — use global directly
      souls.initializeSoul(role);
      souls.writeSoul(role, backup.soul);
      return { success: true, merged: false, source: 'global' };
    }

    const merged = mergeSouls(localSoul, backup.soul);
    souls.writeSoul(role, merged);

    return { success: true, merged: true, source: 'merged' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// =============================================================================
// SOUL MERGE
// =============================================================================

/**
 * Merge two souls — local takes priority for traits, combined for lessons/rules.
 *
 * @param {object} local - Local (project-specific) soul
 * @param {object} global - Global (cross-project) soul
 * @returns {object} Merged soul
 */
function mergeSouls(local, global) {
  const merged = { ...local };

  // Traits: local wins
  merged.traits = { ...global.traits, ...local.traits };

  // Expertise: union (deduplicated)
  const expertiseSet = new Set([...(local.expertise || []), ...(global.expertise || [])]);
  merged.expertise = [...expertiseSet].slice(0, 15);

  // Preferences: union (deduplicated)
  const prefSet = new Set([...(local.preferences || []), ...(global.preferences || [])]);
  merged.preferences = [...prefSet].slice(0, 15);

  // Lessons: combine, newest first, capped
  const allLessons = [...(local.lessons_learned || []), ...(global.lessons_learned || [])];
  // Deduplicate by lesson text
  const seenLessons = new Set();
  merged.lessons_learned = allLessons.filter(l => {
    if (seenLessons.has(l.lesson)) return false;
    seenLessons.add(l.lesson);
    return true;
  }).slice(0, 20);

  // Decision rules: combine, deduplicate by rule text, capped
  const allRules = [...(local.decision_rules || []), ...(global.decision_rules || [])];
  const seenRules = new Set();
  merged.decision_rules = allRules.filter(r => {
    if (seenRules.has(r.rule)) return false;
    seenRules.add(r.rule);
    return true;
  }).slice(0, 15);

  return merged;
}

// =============================================================================
// SNAPSHOTS & DIFF
// =============================================================================

/**
 * Take a snapshot of the current soul state for diff tracking.
 */
function takeSnapshot(role, soul) {
  if (!role) return { success: false, error: 'role required' };

  try {
    if (!soul) {
      const souls = require('./souls');
      soul = souls.loadSoul(role);
    }
    if (!soul) return { success: false, error: 'soul not found' };

    const dir = getSnapshotDir(role);
    ensureDir(dir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${timestamp}.json`);

    const snapshot = {
      role,
      snapshot_at: new Date().toISOString(),
      format_version: SOUL_FORMAT_VERSION,
      soul
    };

    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

    // Cleanup old snapshots
    cleanupSnapshots(role);

    return { success: true, snapshot_path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get diff between two soul snapshots (or current vs latest snapshot).
 *
 * @param {string} role - Agent role
 * @returns {{ diff, changes[] }}
 */
function diffSoul(role) {
  if (!role) return { success: false, error: 'role required' };

  try {
    const souls = require('./souls');
    const current = souls.loadSoul(role);
    if (!current) return { success: false, error: 'current soul not found' };

    const snapshots = listSnapshots(role);
    if (snapshots.length === 0) {
      return { success: true, changes: [], message: 'no snapshots to compare' };
    }

    // Compare against most recent snapshot
    const latest = snapshots[snapshots.length - 1];
    const latestData = JSON.parse(fs.readFileSync(latest.path, 'utf8'));
    const previous = latestData.soul;

    const changes = computeChanges(previous, current);

    return {
      success: true,
      since: latestData.snapshot_at,
      changes
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Compute changes between two soul states.
 */
function computeChanges(prev, current) {
  const changes = [];

  // Lessons added
  const prevLessons = new Set((prev.lessons_learned || []).map(l => l.lesson));
  const currLessons = (current.lessons_learned || []).filter(l => !prevLessons.has(l.lesson));
  if (currLessons.length > 0) {
    changes.push({
      section: 'lessons_learned',
      type: 'added',
      count: currLessons.length,
      items: currLessons.map(l => l.lesson)
    });
  }

  // Lessons removed
  const currLessonSet = new Set((current.lessons_learned || []).map(l => l.lesson));
  const removedLessons = (prev.lessons_learned || []).filter(l => !currLessonSet.has(l.lesson));
  if (removedLessons.length > 0) {
    changes.push({
      section: 'lessons_learned',
      type: 'removed',
      count: removedLessons.length,
      items: removedLessons.map(l => l.lesson)
    });
  }

  // Decision rules added/removed
  const prevRules = new Set((prev.decision_rules || []).map(r => r.rule));
  const currRulesNew = (current.decision_rules || []).filter(r => !prevRules.has(r.rule));
  if (currRulesNew.length > 0) {
    changes.push({
      section: 'decision_rules',
      type: 'added',
      count: currRulesNew.length,
      items: currRulesNew.map(r => r.rule)
    });
  }

  // Expertise changes
  const prevExp = new Set(prev.expertise || []);
  const currExpNew = (current.expertise || []).filter(e => !prevExp.has(e));
  if (currExpNew.length > 0) {
    changes.push({
      section: 'expertise',
      type: 'added',
      count: currExpNew.length,
      items: currExpNew
    });
  }

  // Trait changes
  if (prev.traits && current.traits) {
    for (const [key, val] of Object.entries(current.traits)) {
      if (prev.traits[key] !== val) {
        changes.push({
          section: 'traits',
          type: 'changed',
          key,
          from: prev.traits[key],
          to: val
        });
      }
    }
  }

  return changes;
}

/**
 * List all snapshots for a role.
 */
function listSnapshots(role) {
  const dir = getSnapshotDir(role);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({
      filename: f,
      path: path.join(dir, f)
    }));
}

function cleanupSnapshots(role) {
  const snapshots = listSnapshots(role);
  if (snapshots.length <= MAX_SNAPSHOTS) return;

  const toRemove = snapshots.slice(0, snapshots.length - MAX_SNAPSHOTS);
  for (const snap of toRemove) {
    try { fs.unlinkSync(snap.path); } catch (e) {}
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get a project identifier from cwd.
 */
function getProjectId() {
  return path.basename(process.cwd()).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Check if a global backup exists for a role.
 */
function hasGlobalBackup(role) {
  return fs.existsSync(getGlobalSoulPath(role));
}

/**
 * List all globally backed up souls.
 */
function listGlobalSouls() {
  const dir = getGlobalSoulsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          role: data.role,
          project: data.project,
          backed_up_at: data.backed_up_at,
          format_version: data.format_version
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Backup/restore
  backupSoul,
  restoreSoul,
  hasGlobalBackup,
  listGlobalSouls,

  // Merge
  mergeSouls,

  // Snapshots & diff
  takeSnapshot,
  diffSoul,
  listSnapshots,

  // Config (for testing)
  setGlobalSoulsDir,
  getGlobalSoulsDir,
  SNAPSHOT_DIR,
  SOUL_FORMAT_VERSION,
  MAX_SNAPSHOTS
};
