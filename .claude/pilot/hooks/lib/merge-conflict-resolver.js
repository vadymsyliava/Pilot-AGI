/**
 * Semantic Merge Conflict Resolver — Phase 5.2 (Pilot AGI-hyy)
 *
 * Core engine for AST-aware merge conflict detection and resolution.
 * Parses git conflict markers, classifies conflict types, extracts
 * intent from commit messages and plan steps, applies resolution
 * strategies, and validates results.
 *
 * Architecture:
 *   1. Parse conflict markers → extract base/ours/theirs sections
 *   2. Classify conflict type (additive, rename, overlapping, contradictory)
 *   3. Extract intent from conventional commits + plan steps
 *   4. Apply strategy per conflict type
 *   5. Validate: syntax → semantic → tests
 *   6. Return resolution with confidence score
 *
 * Zero external dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getRegistry,
  extractRegions,
  extractImports,
  mergeImports,
  validateSyntax
} = require('./conflict-parser-registry');

// ============================================================================
// CONSTANTS
// ============================================================================

const STATE_DIR = '.claude/pilot/state/merge-resolutions';

const CONFLICT_TYPES = {
  ADDITIVE: 'additive',           // Both sides add different, non-overlapping content
  OVERLAPPING: 'overlapping',     // Both sides edit the same region
  RENAME: 'rename',               // Same node renamed differently
  DELETE_MODIFY: 'delete_modify', // One deletes, other modifies
  IMPORT_MERGE: 'import_merge',   // Both sides add different imports
  CONTRADICTORY: 'contradictory', // Incompatible changes
  UNKNOWN: 'unknown'
};

const STRATEGIES = {
  COMBINE: 'combine',       // Combine both changes (additive)
  PREFER_OURS: 'prefer_ours',
  PREFER_THEIRS: 'prefer_theirs',
  INTERLEAVE: 'interleave', // Merge imports/declarations
  ESCALATE: 'escalate'      // Too complex for auto-resolution
};

// Conventional commit type priority for conflict resolution
const COMMIT_TYPE_PRIORITY = {
  fix: 5,
  feat: 4,
  refactor: 3,
  test: 2,
  docs: 1,
  chore: 0
};

const MAX_CONFLICT_SIZE = 8000; // bytes
const CONFIDENCE_THRESHOLDS = { high: 0.85, medium: 0.60 };

// ============================================================================
// CONFLICT MARKER PARSER
// ============================================================================

/**
 * Parse git conflict markers from file content.
 * Supports both diff3 (with base) and standard (without base) formats.
 *
 * @param {string} content - File content with conflict markers
 * @returns {Array<{ ours: string, theirs: string, base?: string, startLine: number, endLine: number }>}
 */
function parseConflictMarkers(content) {
  if (!content) return [];

  const lines = content.split('\n');
  const conflicts = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const startLine = i;
      const oursLines = [];
      const baseLines = [];
      const theirsLines = [];
      let section = 'ours';
      let hasBase = false;

      i++;
      while (i < lines.length) {
        if (lines[i].startsWith('|||||||')) {
          section = 'base';
          hasBase = true;
          i++;
          continue;
        }
        if (lines[i].startsWith('=======')) {
          section = 'theirs';
          i++;
          continue;
        }
        if (lines[i].startsWith('>>>>>>>')) {
          conflicts.push({
            ours: oursLines.join('\n'),
            theirs: theirsLines.join('\n'),
            base: hasBase ? baseLines.join('\n') : undefined,
            startLine,
            endLine: i
          });
          break;
        }

        if (section === 'ours') oursLines.push(lines[i]);
        else if (section === 'base') baseLines.push(lines[i]);
        else if (section === 'theirs') theirsLines.push(lines[i]);
        i++;
      }
    }
    i++;
  }

  return conflicts;
}

/**
 * Extract the non-conflict portions of a file (context around conflicts).
 *
 * @param {string} content - File content with conflict markers
 * @returns {{ before: string, after: string, betweenConflicts: string[] }}
 */
function extractContext(content) {
  const lines = content.split('\n');
  const parts = { before: [], after: [], betweenConflicts: [] };
  let inConflict = false;
  let afterLastConflict = [];
  let seenConflict = false;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      if (seenConflict && afterLastConflict.length > 0) {
        parts.betweenConflicts.push(afterLastConflict.join('\n'));
        afterLastConflict = [];
      }
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      inConflict = false;
      seenConflict = true;
      continue;
    }
    if (line.startsWith('|||||||') || line.startsWith('=======')) continue;

    if (inConflict) continue;

    if (!seenConflict) {
      parts.before.push(line);
    } else {
      afterLastConflict.push(line);
    }
  }

  parts.before = parts.before.join('\n');
  parts.after = afterLastConflict.join('\n');
  return parts;
}

// ============================================================================
// CONFLICT CLASSIFICATION
// ============================================================================

/**
 * Classify the type of a single conflict region.
 *
 * @param {{ ours: string, theirs: string, base?: string }} conflict
 * @param {string} filePath
 * @returns {{ type: string, details: object }}
 */
function classifyConflict(conflict, filePath) {
  const registry = getRegistry();
  const profile = registry.getByFilePath(filePath);

  // If no parser available, classify as unknown
  if (!profile) {
    return { type: CONFLICT_TYPES.UNKNOWN, details: { reason: 'unsupported_language' } };
  }

  const { ours, theirs, base } = conflict;

  // Check for import-only conflicts
  if (isImportOnly(ours, profile) && isImportOnly(theirs, profile)) {
    return { type: CONFLICT_TYPES.IMPORT_MERGE, details: { language: profile.name } };
  }

  // If we have base, we can do three-way analysis
  if (base !== undefined) {
    // Delete/modify: one side is empty (or close to base), other modifies
    if (base && !ours.trim() && theirs.trim()) {
      return { type: CONFLICT_TYPES.DELETE_MODIFY, details: { deleted: 'ours', modified: 'theirs' } };
    }
    if (base && ours.trim() && !theirs.trim()) {
      return { type: CONFLICT_TYPES.DELETE_MODIFY, details: { deleted: 'theirs', modified: 'ours' } };
    }

    // Additive: base is empty/minimal, both sides add content
    if (!base.trim() && ours.trim() && theirs.trim()) {
      return { type: CONFLICT_TYPES.ADDITIVE, details: { language: profile.name } };
    }

    // Check if it's a rename
    const renameResult = detectRename(base, ours, theirs, profile);
    if (renameResult.isRename) {
      return { type: CONFLICT_TYPES.RENAME, details: renameResult };
    }
  }

  // Check additive (no base available): both sides add non-overlapping declarations
  const oursRegions = extractRegions(ours, profile);
  const theirsRegions = extractRegions(theirs, profile);

  if (oursRegions.length > 0 && theirsRegions.length > 0) {
    const oursNames = new Set(oursRegions.map(r => r.name));
    const theirsNames = new Set(theirsRegions.map(r => r.name));
    const overlap = [...oursNames].filter(n => theirsNames.has(n));

    if (overlap.length === 0) {
      return { type: CONFLICT_TYPES.ADDITIVE, details: { oursDecls: [...oursNames], theirsDecls: [...theirsNames] } };
    }
  }

  // Check if changes are too different to reconcile
  const similarity = computeSimilarity(ours, theirs);
  if (similarity < 0.2) {
    return { type: CONFLICT_TYPES.CONTRADICTORY, details: { similarity } };
  }

  // Default: overlapping edits
  return { type: CONFLICT_TYPES.OVERLAPPING, details: { similarity } };
}

/**
 * Check if text consists only of import statements.
 */
function isImportOnly(text, profile) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  return lines.every(line => {
    const trimmed = line.trim();
    return profile.importPatterns.some(p => p.test(trimmed));
  });
}

/**
 * Detect if the conflict is a rename operation.
 */
function detectRename(base, ours, theirs, profile) {
  const baseRegions = extractRegions(base, profile);
  const oursRegions = extractRegions(ours, profile);
  const theirsRegions = extractRegions(theirs, profile);

  if (baseRegions.length !== 1 || oursRegions.length !== 1 || theirsRegions.length !== 1) {
    return { isRename: false };
  }

  const baseName = baseRegions[0].name;
  const oursName = oursRegions[0].name;
  const theirsName = theirsRegions[0].name;

  if (baseName !== oursName && baseName !== theirsName && oursName !== theirsName) {
    return {
      isRename: true,
      baseName,
      oursName,
      theirsName
    };
  }

  return { isRename: false };
}

/**
 * Compute similarity between two strings (simple Jaccard on lines).
 */
function computeSimilarity(a, b) {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;

  const aLines = new Set(a.split('\n').map(l => l.trim()).filter(Boolean));
  const bLines = new Set(b.split('\n').map(l => l.trim()).filter(Boolean));

  if (aLines.size === 0 && bLines.size === 0) return 1.0;

  let intersection = 0;
  for (const line of aLines) {
    if (bLines.has(line)) intersection++;
  }

  const union = aLines.size + bLines.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ============================================================================
// INTENT EXTRACTION
// ============================================================================

/**
 * Parse a conventional commit message into structured intent.
 *
 * @param {string} message - Commit message
 * @returns {{ type: string, scope: string, description: string, taskId?: string, priority: number }}
 */
function parseCommitIntent(message) {
  if (!message) return { type: 'unknown', scope: '', description: message || '', priority: 0 };

  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(?:!)?\s*:\s*(.+?)(?:\s*\[([^\]]+)\])?$/);
  if (!match) {
    return { type: 'unknown', scope: '', description: message.trim(), priority: 0 };
  }

  const type = match[1].toLowerCase();
  return {
    type,
    scope: match[2] || '',
    description: match[3].trim(),
    taskId: match[4] || undefined,
    priority: COMMIT_TYPE_PRIORITY[type] || 0
  };
}

/**
 * Load plan steps for a task (from approved plans).
 *
 * @param {string} taskId
 * @param {string} projectRoot
 * @returns {object|null}
 */
function loadPlanContext(taskId, projectRoot) {
  if (!taskId || !projectRoot) return null;

  const planPath = path.join(projectRoot, '.claude/pilot/state/approved-plans', taskId + '.json');
  try {
    if (fs.existsSync(planPath)) {
      return JSON.parse(fs.readFileSync(planPath, 'utf8'));
    }
  } catch (e) { /* Plan not available */ }
  return null;
}

/**
 * Determine which side's intent should win in a conflict.
 *
 * @param {{ type: string, priority: number }} oursIntent
 * @param {{ type: string, priority: number }} theirsIntent
 * @returns {'ours' | 'theirs' | 'equal'}
 */
function compareIntent(oursIntent, theirsIntent) {
  if (oursIntent.priority > theirsIntent.priority) return 'ours';
  if (theirsIntent.priority > oursIntent.priority) return 'theirs';
  return 'equal';
}

// ============================================================================
// RESOLUTION STRATEGIES
// ============================================================================

/**
 * Resolve a single conflict region.
 *
 * @param {{ ours: string, theirs: string, base?: string }} conflict
 * @param {{ type: string, details: object }} classification
 * @param {{ oursIntent?: object, theirsIntent?: object }} intentContext
 * @param {string} filePath
 * @returns {{ resolved: string, strategy: string, confidence: number }}
 */
function resolveConflictRegion(conflict, classification, intentContext, filePath) {
  const { ours, theirs } = conflict;
  const registry = getRegistry();
  const profile = registry.getByFilePath(filePath);

  switch (classification.type) {
    case CONFLICT_TYPES.IMPORT_MERGE:
      return resolveImportMerge(ours, theirs, profile);

    case CONFLICT_TYPES.ADDITIVE:
      return resolveAdditive(ours, theirs, profile);

    case CONFLICT_TYPES.DELETE_MODIFY:
      return resolveDeleteModify(conflict, classification, intentContext);

    case CONFLICT_TYPES.RENAME:
      return resolveRename(conflict, classification, intentContext);

    case CONFLICT_TYPES.OVERLAPPING:
      return resolveOverlapping(conflict, classification, intentContext, profile);

    case CONFLICT_TYPES.CONTRADICTORY:
      return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0 };

    default:
      return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0.1 };
  }
}

/**
 * Resolve import conflicts by merging both import sets.
 */
function resolveImportMerge(ours, theirs, profile) {
  if (!profile) {
    return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0.2 };
  }

  const oursImports = extractImports(ours, profile);
  const theirsImports = extractImports(theirs, profile);
  const merged = mergeImports(oursImports, theirsImports);

  return {
    resolved: merged.join('\n'),
    strategy: STRATEGIES.INTERLEAVE,
    confidence: 0.95
  };
}

/**
 * Resolve additive conflicts by combining both additions.
 */
function resolveAdditive(ours, theirs, profile) {
  // Both add non-overlapping content — combine with a blank line separator
  const combined = ours.trimEnd() + '\n\n' + theirs.trimEnd();

  // Validate syntax
  if (profile) {
    const validation = validateSyntax(combined, profile);
    if (!validation.valid) {
      return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0.3 };
    }
  }

  return {
    resolved: combined,
    strategy: STRATEGIES.COMBINE,
    confidence: 0.88
  };
}

/**
 * Resolve delete/modify conflicts using intent.
 */
function resolveDeleteModify(conflict, classification, intentContext) {
  const { deleted, modified } = classification.details;

  // If we have intent context, check which operation has higher priority
  if (intentContext.oursIntent && intentContext.theirsIntent) {
    const winner = compareIntent(intentContext.oursIntent, intentContext.theirsIntent);
    if (winner === 'ours' && deleted === 'theirs') {
      return { resolved: conflict.ours, strategy: STRATEGIES.PREFER_OURS, confidence: 0.70 };
    }
    if (winner === 'theirs' && deleted === 'ours') {
      return { resolved: conflict.theirs, strategy: STRATEGIES.PREFER_THEIRS, confidence: 0.70 };
    }
  }

  // Default: prefer the modification (preserve code rather than delete)
  const resolved = modified === 'ours' ? conflict.ours : conflict.theirs;
  const strategy = modified === 'ours' ? STRATEGIES.PREFER_OURS : STRATEGIES.PREFER_THEIRS;

  return { resolved, strategy, confidence: 0.65 };
}

/**
 * Resolve rename conflicts using intent.
 */
function resolveRename(conflict, classification, intentContext) {
  // If we have intent, prefer the higher-priority rename
  if (intentContext.oursIntent && intentContext.theirsIntent) {
    const winner = compareIntent(intentContext.oursIntent, intentContext.theirsIntent);
    if (winner === 'ours') {
      return { resolved: conflict.ours, strategy: STRATEGIES.PREFER_OURS, confidence: 0.65 };
    }
    if (winner === 'theirs') {
      return { resolved: conflict.theirs, strategy: STRATEGIES.PREFER_THEIRS, confidence: 0.65 };
    }
  }

  // No clear winner — escalate
  return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0.3 };
}

/**
 * Resolve overlapping edits (most complex case).
 */
function resolveOverlapping(conflict, classification, intentContext, profile) {
  const { ours, theirs, base } = conflict;

  // If similarity is very high, changes are nearly identical — pick either
  if (classification.details.similarity > 0.9) {
    return { resolved: ours, strategy: STRATEGIES.PREFER_OURS, confidence: 0.85 };
  }

  // If we have base, try line-level three-way merge
  if (base !== undefined) {
    const result = threeWayLineMerge(base, ours, theirs);
    if (result.success) {
      // Validate syntax
      if (profile) {
        const validation = validateSyntax(result.merged, profile);
        if (validation.valid) {
          return { resolved: result.merged, strategy: STRATEGIES.COMBINE, confidence: 0.75 };
        }
      } else {
        return { resolved: result.merged, strategy: STRATEGIES.COMBINE, confidence: 0.65 };
      }
    }
  }

  // Use intent priority to pick a side
  if (intentContext.oursIntent && intentContext.theirsIntent) {
    const winner = compareIntent(intentContext.oursIntent, intentContext.theirsIntent);
    if (winner !== 'equal') {
      const resolved = winner === 'ours' ? ours : theirs;
      const strategy = winner === 'ours' ? STRATEGIES.PREFER_OURS : STRATEGIES.PREFER_THEIRS;
      return { resolved, strategy, confidence: 0.55 };
    }
  }

  // Cannot resolve automatically
  return { resolved: null, strategy: STRATEGIES.ESCALATE, confidence: 0.2 };
}

/**
 * Simple three-way line merge.
 * For each line, if changed in only one side, take that change.
 * If changed in both sides, it's a conflict.
 *
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @returns {{ success: boolean, merged?: string, conflictLines?: number[] }}
 */
function threeWayLineMerge(base, ours, theirs) {
  const baseLines = base.split('\n');
  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');

  // Build simple LCS-based alignment
  const maxLen = Math.max(baseLines.length, oursLines.length, theirsLines.length);
  const merged = [];
  const conflictLines = [];

  // Simple approach: iterate up to max length
  for (let i = 0; i < maxLen; i++) {
    const b = i < baseLines.length ? baseLines[i] : undefined;
    const o = i < oursLines.length ? oursLines[i] : undefined;
    const t = i < theirsLines.length ? theirsLines[i] : undefined;

    if (o === t) {
      // Both agree
      if (o !== undefined) merged.push(o);
    } else if (o === b) {
      // Only theirs changed
      if (t !== undefined) merged.push(t);
    } else if (t === b) {
      // Only ours changed
      if (o !== undefined) merged.push(o);
    } else {
      // Both changed differently — conflict
      conflictLines.push(i);
      return { success: false, conflictLines };
    }
  }

  return { success: true, merged: merged.join('\n') };
}

// ============================================================================
// MAIN RESOLVER
// ============================================================================

/**
 * Resolve all conflicts in a file.
 *
 * @param {string} filePath - Path to the file with conflicts
 * @param {object} opts
 * @param {string} opts.projectRoot - Project root
 * @param {string} opts.oursCommitMsg - Our branch's last commit message
 * @param {string} opts.theirsCommitMsg - Their branch's last commit message
 * @param {string} opts.oursTaskId - Our task ID
 * @param {string} opts.theirsTaskId - Their task ID
 * @returns {{ success: boolean, resolvedContent?: string, resolutions: Array, overallConfidence: number, needsEscalation: boolean }}
 */
function resolveFile(filePath, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    return { success: false, resolutions: [], overallConfidence: 0, needsEscalation: true, error: 'Cannot read file: ' + e.message };
  }

  // Check size limit
  if (content.length > MAX_CONFLICT_SIZE * 4) {
    return { success: false, resolutions: [], overallConfidence: 0, needsEscalation: true, error: 'File too large for auto-resolution' };
  }

  const conflicts = parseConflictMarkers(content);
  if (conflicts.length === 0) {
    return { success: true, resolvedContent: content, resolutions: [], overallConfidence: 1.0, needsEscalation: false };
  }

  // Extract intent
  const oursIntent = parseCommitIntent(opts.oursCommitMsg);
  const theirsIntent = parseCommitIntent(opts.theirsCommitMsg);
  const intentContext = { oursIntent, theirsIntent };

  // Load plan context if available
  if (opts.oursTaskId) {
    intentContext.oursPlan = loadPlanContext(opts.oursTaskId, projectRoot);
  }
  if (opts.theirsTaskId) {
    intentContext.theirsPlan = loadPlanContext(opts.theirsTaskId, projectRoot);
  }

  // Resolve each conflict
  const resolutions = [];
  let allResolved = true;

  for (const conflict of conflicts) {
    const classification = classifyConflict(conflict, filePath);
    const resolution = resolveConflictRegion(conflict, classification, intentContext, filePath);

    resolutions.push({
      conflict,
      classification,
      resolution,
      lines: { start: conflict.startLine, end: conflict.endLine }
    });

    if (!resolution.resolved && resolution.strategy === STRATEGIES.ESCALATE) {
      allResolved = false;
    }
  }

  // If all resolved, reconstruct the file
  let resolvedContent = null;
  const overallConfidence = resolutions.length > 0
    ? resolutions.reduce((sum, r) => sum + r.resolution.confidence, 0) / resolutions.length
    : 1.0;

  if (allResolved) {
    resolvedContent = reconstructFile(content, conflicts, resolutions);

    // Final syntax validation
    const registry = getRegistry();
    const profile = registry.getByFilePath(filePath);
    if (profile) {
      const validation = validateSyntax(resolvedContent, profile);
      if (!validation.valid) {
        return {
          success: false,
          resolutions,
          overallConfidence: overallConfidence * 0.5,
          needsEscalation: true,
          error: 'Syntax validation failed after resolution: ' + validation.error
        };
      }
    }
  }

  return {
    success: allResolved,
    resolvedContent,
    resolutions,
    overallConfidence,
    needsEscalation: !allResolved || overallConfidence < CONFIDENCE_THRESHOLDS.medium
  };
}

/**
 * Reconstruct file by replacing conflict markers with resolved content.
 *
 * @param {string} originalContent - File with conflict markers
 * @param {Array} conflicts - Parsed conflict regions
 * @param {Array} resolutions - Resolution results
 * @returns {string}
 */
function reconstructFile(originalContent, conflicts, resolutions) {
  const lines = originalContent.split('\n');
  const result = [];
  let lastEnd = -1;

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i];
    const resolution = resolutions[i];

    // Add lines before this conflict (after last conflict)
    for (let j = lastEnd + 1; j < conflict.startLine; j++) {
      result.push(lines[j]);
    }

    // Add resolved content
    if (resolution.resolution.resolved !== null) {
      result.push(resolution.resolution.resolved);
    }

    lastEnd = conflict.endLine;
  }

  // Add remaining lines after last conflict
  for (let j = lastEnd + 1; j < lines.length; j++) {
    result.push(lines[j]);
  }

  return result.join('\n');
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Get the state directory path.
 */
function getStateDir(projectRoot) {
  return path.join(projectRoot || process.cwd(), STATE_DIR);
}

/**
 * Save resolution result for audit trail.
 *
 * @param {string} taskId
 * @param {string} filePath
 * @param {object} result - Resolution result
 * @param {string} projectRoot
 */
function saveResolution(taskId, filePath, result, projectRoot) {
  const dir = getStateDir(projectRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* exists */ }

  const stateFile = path.join(dir, (taskId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');

  let state = { resolutions: [] };
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) { /* corrupt or missing */ }

  state.resolutions.push({
    file: filePath,
    timestamp: new Date().toISOString(),
    success: result.success,
    confidence: result.overallConfidence,
    conflictCount: result.resolutions.length,
    strategies: result.resolutions.map(r => r.resolution.strategy),
    types: result.resolutions.map(r => r.classification.type),
    needsEscalation: result.needsEscalation
  });

  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

/**
 * Load resolution history for a task.
 */
function loadResolutions(taskId, projectRoot) {
  const stateFile = path.join(getStateDir(projectRoot), (taskId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) { /* corrupt */ }
  return { resolutions: [] };
}

// ============================================================================
// HIGH-LEVEL API
// ============================================================================

/**
 * Resolve all conflicting files from a git merge.
 *
 * @param {string[]} conflictFiles - List of conflicting file paths
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.oursCommitMsg
 * @param {string} opts.theirsCommitMsg
 * @param {string} opts.oursTaskId
 * @param {string} opts.theirsTaskId
 * @param {boolean} opts.testValidation - Whether to run tests after resolution
 * @returns {{ success: boolean, files: object, overallConfidence: number, needsEscalation: boolean, resolvedCount: number, escalatedCount: number }}
 */
function resolveAllConflicts(conflictFiles, opts = {}) {
  const results = {};
  let resolvedCount = 0;
  let escalatedCount = 0;
  let totalConfidence = 0;

  for (const file of conflictFiles) {
    const result = resolveFile(file, opts);
    results[file] = result;

    if (result.success) {
      resolvedCount++;
    } else {
      escalatedCount++;
    }

    totalConfidence += result.overallConfidence;

    // Save resolution state
    if (opts.oursTaskId || opts.theirsTaskId) {
      saveResolution(opts.oursTaskId || opts.theirsTaskId, file, result, opts.projectRoot);
    }
  }

  const overallConfidence = conflictFiles.length > 0
    ? totalConfidence / conflictFiles.length
    : 1.0;

  return {
    success: escalatedCount === 0,
    files: results,
    overallConfidence,
    needsEscalation: escalatedCount > 0 || overallConfidence < CONFIDENCE_THRESHOLDS.medium,
    resolvedCount,
    escalatedCount
  };
}

/**
 * Apply resolved content to files on disk.
 *
 * @param {object} resolutionResults - Output from resolveAllConflicts()
 * @param {string} projectRoot
 * @returns {{ applied: string[], failed: string[] }}
 */
function applyResolutions(resolutionResults, projectRoot) {
  const applied = [];
  const failed = [];

  for (const [file, result] of Object.entries(resolutionResults.files || {})) {
    if (!result.success || !result.resolvedContent) {
      failed.push(file);
      continue;
    }

    const fullPath = path.isAbsolute(file) ? file : path.join(projectRoot || process.cwd(), file);
    try {
      fs.writeFileSync(fullPath, result.resolvedContent);
      applied.push(file);
    } catch (e) {
      failed.push(file);
    }
  }

  return { applied, failed };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  CONFLICT_TYPES,
  STRATEGIES,
  CONFIDENCE_THRESHOLDS,
  COMMIT_TYPE_PRIORITY,

  // Conflict parsing
  parseConflictMarkers,
  extractContext,

  // Classification
  classifyConflict,
  computeSimilarity,

  // Intent
  parseCommitIntent,
  loadPlanContext,
  compareIntent,

  // Resolution
  resolveConflictRegion,
  resolveFile,
  resolveAllConflicts,
  applyResolutions,
  threeWayLineMerge,
  reconstructFile,

  // State
  saveResolution,
  loadResolutions,
  getStateDir
};
