/**
 * Tests for skill-registry — S1.2 (Sprint 1, 2026-04-28)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const registry = require('../skill-registry');

let testDir;
function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-reg-'));
  // Project skills
  for (const [name, desc] of [
    ['pilot-init', 'Initialize a new project'],
    ['pilot-plan', 'Plan a task'],
    ['pilot-exec', 'Execute one micro-step']
  ]) {
    const dir = path.join(testDir, '.claude/skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: /${name}\ndescription: "${desc}"\n---\n# ${name}\n\nUse this when user types /${name}.`);
  }
  // One with args marker
  const argsDir = path.join(testDir, '.claude/skills/pilot-sprint');
  fs.mkdirSync(argsDir, { recursive: true });
  fs.writeFileSync(path.join(argsDir, 'SKILL.md'),
    '---\nname: /pilot-sprint\ndescription: "Plan a sprint"\n---\nGiven $ARGUMENTS, plan...');
}
function teardown() { fs.rmSync(testDir, { recursive: true, force: true }); }

let passed = 0, failed = 0; const failures = [];
function test(name, fn) {
  setup();
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.error('  ✗ ' + name); console.error('    ' + e.message); }
  finally { teardown(); }
}

console.log('\n=== Skill Registry Tests ===\n');

test('listSkills finds project skills', () => {
  const skills = registry.listSkills(testDir);
  const names = skills.map(s => s.name).filter(n => n.startsWith('/pilot-'));
  assert.ok(names.includes('/pilot-init'));
  assert.ok(names.includes('/pilot-plan'));
  assert.ok(names.includes('/pilot-exec'));
});

test('description is parsed from frontmatter (with quotes)', () => {
  const skill = registry.findSkill('/pilot-init', testDir);
  assert.strictEqual(skill.description, 'Initialize a new project');
});

test('hasArgs flag detects $ARGUMENTS marker', () => {
  const sprint = registry.findSkill('/pilot-sprint', testDir);
  assert.strictEqual(sprint.hasArgs, true);
  const init = registry.findSkill('/pilot-init', testDir);
  assert.strictEqual(init.hasArgs, false);
});

test('findSkill normalizes leading slash', () => {
  const a = registry.findSkill('/pilot-plan', testDir);
  const b = registry.findSkill('pilot-plan', testDir);
  assert.deepStrictEqual(a, b);
});

test('findSkill returns null on miss', () => {
  assert.strictEqual(registry.findSkill('/nonexistent', testDir), null);
});

test('category inference for pilot-* names', () => {
  assert.strictEqual(registry.findSkill('/pilot-init', testDir).category, 'planning');
  assert.strictEqual(registry.findSkill('/pilot-plan', testDir).category, 'loop');
  assert.strictEqual(registry.findSkill('/pilot-exec', testDir).category, 'loop');
});

test('skills sorted alphabetically', () => {
  const skills = registry.listSkills(testDir);
  const projectSkills = skills.filter(s => s.source === 'project');
  const names = projectSkills.map(s => s.name);
  const sorted = [...names].sort();
  assert.deepStrictEqual(names, sorted);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) { console.error(failures.join('\n')); process.exit(1); }
