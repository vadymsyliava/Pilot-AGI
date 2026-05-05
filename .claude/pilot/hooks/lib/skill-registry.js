/**
 * Skill Registry — S1.2 (Sprint 1, 2026-04-28)
 *
 * Lists installed Claude Code skills available for execution. Reads
 * SKILL.md frontmatter from:
 *   1. <projectRoot>/.claude/skills/        (per-project)
 *   2. ~/.claude/skills/                    (user-global)
 *   3. <projectRoot>/.claude/plugins/cache/ (plugin-installed)
 *
 * Returns a deduplicated list { name, description, category, hasArgs,
 *   path, source } for Studio's completion popover + skill-execution UI.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_DIRS = (projectRoot) => [
  { dir: path.join(projectRoot || '.', '.claude/skills'), source: 'project' },
  { dir: path.join(os.homedir(), '.claude/skills'),       source: 'user' }
];

function _parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const close = raw.indexOf('\n---', 3);
  if (close < 0) return null;
  const block = raw.slice(3, close);
  const out = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function _scanDir(dir, source) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name);
    const skillMd = path.join(skillPath, 'SKILL.md');
    let raw;
    try { raw = fs.readFileSync(skillMd, 'utf8'); }
    catch (e) { continue; }
    const fm = _parseFrontmatter(raw);
    if (!fm || !fm.name) continue;
    out.push({
      name: fm.name.startsWith('/') ? fm.name : '/' + fm.name,
      description: fm.description || '',
      category: fm.category || _categorize(fm.name),
      hasArgs: /\$ARGUMENTS|\<arg|\<args/.test(raw),
      path: skillPath,
      source
    });
  }
  return out;
}

function _categorize(name) {
  // Strip leading slash so frontmatter "name: /pilot-init" categorizes correctly.
  if (typeof name === 'string' && name.startsWith('/')) name = name.slice(1);
  if (name.startsWith('pilot-')) {
    if (/init|sprint|status|next|new-task/.test(name)) return 'planning';
    if (/plan|exec|commit|review|close|approve/.test(name)) return 'loop';
    if (/research|design|test|orchestrate|parallel/.test(name)) return 'execution';
    if (/dashboard|checkpoint|message|update|help/.test(name)) return 'meta';
  }
  if (name.startsWith('gsd-')) return 'gsd';
  return 'general';
}

/**
 * Return the deduplicated, sorted skill list. Project skills shadow
 * user-global ones with the same name.
 */
function listSkills(projectRoot) {
  const seen = new Set();
  const result = [];
  for (const { dir, source } of SKILL_DIRS(projectRoot)) {
    for (const skill of _scanDir(dir, source)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      result.push(skill);
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up one skill by name. Returns null if not found. */
function findSkill(name, projectRoot) {
  const normalized = name.startsWith('/') ? name : '/' + name;
  return listSkills(projectRoot).find(s => s.name === normalized) || null;
}

module.exports = { listSkills, findSkill };
