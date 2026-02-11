/**
 * Tests for Session Guardian integration points
 * - Auto-claim wiring in pilot-next skill
 * - Rich session awareness on startup
 * - Session announce broadcast event
 */
const fs = require('fs');
const path = require('path');

const session = require('../.claude/pilot/hooks/lib/session');
const messaging = require('../.claude/pilot/hooks/lib/messaging');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '-', e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('Session Guardian Integration Tests');
console.log('='.repeat(50));

// --- pilot-next skill: auto-claim step ---

console.log('\n--- pilot-next auto-claim ---');

test('pilot-next SKILL.md contains Step 5.2 (claim task)', () => {
  const skillPath = path.join(__dirname, '../.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('5.2: Claim task in session state'),
    'SKILL.md should contain Step 5.2 for claiming tasks');
});

test('pilot-next SKILL.md references claimed_task update', () => {
  const skillPath = path.join(__dirname, '../.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('claimed_task'),
    'SKILL.md should reference claimed_task field');
});

test('pilot-next SKILL.md has correct step numbering (5.1 through 5.5)', () => {
  const skillPath = path.join(__dirname, '../.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('5.1:'), 'Should have step 5.1');
  assert(content.includes('5.2:'), 'Should have step 5.2');
  assert(content.includes('5.3:'), 'Should have step 5.3');
  assert(content.includes('5.4:'), 'Should have step 5.4');
  assert(content.includes('5.5:'), 'Should have step 5.5');
});

test('pilot-next SKILL.md mentions multi-session coordination', () => {
  const skillPath = path.join(__dirname, '../.claude/skills/pilot-next/SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert(content.includes('multi-session coordination'),
    'Should mention multi-session coordination purpose');
});

// --- session-start.js: rich awareness ---

console.log('\n--- session-start.js rich awareness ---');

test('session-start.js includes agent number display', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('You are Agent'),
    'Should display agent number on startup');
});

test('session-start.js shows per-agent task status', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('claimed_task') && content.includes('working on'),
    'Should show what each peer is working on');
});

test('session-start.js shows locked areas in startup', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('Locked areas:'),
    'Should display locked areas summary on startup');
});

// --- session-start.js: announce event ---

console.log('\n--- session-start.js announce event ---');

test('session-start.js emits session_announced event', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('session_announced'),
    'Should emit session_announced event');
});

test('session-start.js broadcasts via message bus on startup', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('sendBroadcast'),
    'Should broadcast new agent joined via message bus');
});

test('session-start.js announce is best-effort (try/catch)', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/session-start.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  // Check that the announce block is wrapped in try/catch
  assert(content.includes("Best effort") || content.includes("don't block startup"),
    'Announce should not block startup on failure');
});

// --- session module: core functions still work ---

console.log('\n--- session module core functions ---');

test('session.generateSessionId returns valid ID', () => {
  const id = session.generateSessionId();
  assert(typeof id === 'string', 'Should return string');
  assert(id.startsWith('S-'), 'Should start with S-');
});

test('session.isSessionAlive returns boolean for unknown session', () => {
  const result = session.isSessionAlive('S-nonexistent-999');
  assert(typeof result === 'boolean', 'Should return boolean');
  assert(result === false, 'Nonexistent session should not be alive');
});

test('session.getAllSessionStates returns array', () => {
  const states = session.getAllSessionStates();
  assert(Array.isArray(states), 'Should return array');
});

test('session.getActiveSessions returns array', () => {
  const active = session.getActiveSessions('S-test-guardian');
  assert(Array.isArray(active), 'Should return array');
});

// --- messaging module: broadcast still works ---

console.log('\n--- messaging module ---');

test('messaging.sendBroadcast is a function', () => {
  assert(typeof messaging.sendBroadcast === 'function',
    'sendBroadcast should be exported as function');
});

test('messaging.sendNotification is a function', () => {
  assert(typeof messaging.sendNotification === 'function',
    'sendNotification should be exported as function');
});

// --- user-prompt-submit.js: session awareness ---

console.log('\n--- user-prompt-submit.js awareness ---');

test('user-prompt-submit.js has buildSessionAwareness function', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/user-prompt-submit.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('buildSessionAwareness'),
    'Should have buildSessionAwareness function');
});

test('user-prompt-submit.js injects awareness with active task', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/user-prompt-submit.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('sessionAwareness') && content.includes('activeTask'),
    'Should inject session awareness even when active task exists');
});

test('user-prompt-submit.js uses lockfile-based liveness', () => {
  const hookPath = path.join(__dirname, '../.claude/pilot/hooks/user-prompt-submit.js');
  const content = fs.readFileSync(hookPath, 'utf8');
  assert(content.includes('isSessionAlive'),
    'Should use lockfile-based isSessionAlive for accurate liveness');
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
