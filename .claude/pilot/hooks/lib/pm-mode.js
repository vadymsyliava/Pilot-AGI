/**
 * PM Mode — Sprint 4 T1 (M1.5)
 *
 * Persistent flag controlling whether PM intervenes in chats:
 *   - "strict_rules" (default): PM only answers explicit /decompose
 *     questions; never auto-responds; does not run review flow side
 *     effects.
 *   - "free_chat":   PM responds to any chat marked pm_requested=true,
 *     auto-routes via ask-pm. Auto-responder loop ticks while the
 *     daemon runs.
 *   - "off":         PM totally silent; only file-bus state writes
 *     happen. Useful for raw chat-with-Claude mode.
 *
 * Stored in <projectRoot>/.claude/pilot/state/orchestrator/pm-mode.json
 *   { version, mode, updatedAt }
 *
 * All writes atomic via tmp-rename. All reads tolerant of missing
 * file / malformed JSON (return DEFAULT_MODE).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_MODES = ['strict_rules', 'free_chat', 'off'];
const DEFAULT_MODE = 'strict_rules';

function modePath(projectRoot) {
  return path.join(
    projectRoot,
    '.claude/pilot/state/orchestrator/pm-mode.json'
  );
}

function isValidMode(m) {
  return typeof m === 'string' && VALID_MODES.includes(m);
}

/**
 * Read the current PM mode for a project. Returns DEFAULT_MODE on
 * missing file / parse error / invalid value.
 */
function getPmMode(projectRoot) {
  try {
    const raw = fs.readFileSync(modePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && isValidMode(parsed.mode)) return parsed.mode;
  } catch (e) { /* fall through */ }
  return DEFAULT_MODE;
}

/**
 * Set the PM mode. Returns { success, mode } on success;
 * { success: false, error } on invalid input.
 */
function setPmMode(projectRoot, mode) {
  if (!isValidMode(mode)) {
    return { success: false, error: `Invalid mode "${mode}" — must be one of: ${VALID_MODES.join(', ')}` };
  }
  const filePath = modePath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const obj = { version: 1, mode, updatedAt: new Date().toISOString() };
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
    return { success: true, mode };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { getPmMode, setPmMode, isValidMode, VALID_MODES, DEFAULT_MODE };
