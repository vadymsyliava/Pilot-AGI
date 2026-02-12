#!/usr/bin/env node

/**
 * Verification tests for Design Agent (Phase 2.8)
 * Run: node tests/design-agent.test.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL: ' + name + ' - ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

const ROOT = path.join(__dirname, '..');

// =========================================================================
// 1. Agent Registry
// =========================================================================

console.log('\n--- Agent Registry ---');

test('agent-registry.json is valid JSON', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  assert(data.agents, 'Missing agents key');
});

test('design agent exists in registry', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  assert(data.agents.design, 'Missing design agent');
  assert(data.agents.design.name === 'Design Agent', 'Wrong agent name');
});

test('design agent has required fields', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  const agent = data.agents.design;
  assert(agent.rules_file, 'Missing rules_file');
  assert(agent.capabilities && agent.capabilities.length > 0, 'Missing capabilities');
  assert(agent.file_patterns && agent.file_patterns.length > 0, 'Missing file_patterns');
  assert(agent.task_indicators && agent.task_indicators.length > 0, 'Missing task_indicators');
  assert(agent.memory, 'Missing memory config');
  assert(agent.memory.publishes.includes('design-tokens'), 'Must publish design-tokens');
  assert(agent.decomposition, 'Missing decomposition config');
});

test('design agent rules_file points to existing file', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  const rulesPath = path.join(ROOT, data.agents.design.rules_file);
  assert(fs.existsSync(rulesPath), `Rules file not found: ${rulesPath}`);
});

test('design_system_update orchestration pattern exists', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  assert(data.orchestration.patterns.design_system_update, 'Missing design_system_update pattern');
  assert(data.orchestration.patterns.design_system_update.agents.includes('design'), 'Pattern must include design agent');
});

test('ui_with_design orchestration pattern exists', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/agent-registry.json'), 'utf8'));
  assert(data.orchestration.patterns.ui_with_design, 'Missing ui_with_design pattern');
  assert(data.orchestration.patterns.ui_with_design.agents.includes('design'), 'Pattern must include design agent');
  assert(data.orchestration.patterns.ui_with_design.agents.includes('frontend'), 'Pattern must include frontend agent');
});

// =========================================================================
// 2. Design Rules YAML
// =========================================================================

console.log('\n--- Design Rules YAML ---');

test('design.yaml exists and is readable', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.length > 100, 'File too short');
});

test('design.yaml has required sections', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('version:'), 'Missing version');
  assert(content.includes('scope:'), 'Missing scope');
  assert(content.includes('must:'), 'Missing must rules');
  assert(content.includes('must_not:'), 'Missing must_not rules');
  assert(content.includes('verification:'), 'Missing verification');
});

test('design.yaml covers DTCG format rule', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('dtcg_format'), 'Missing DTCG format rule');
  assert(content.includes('$value'), 'Must reference $value');
  assert(content.includes('$type'), 'Must reference $type');
});

test('design.yaml covers hardcoded value prohibition', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('hardcoded_colors'), 'Missing hardcoded colors rule');
  assert(content.includes('hardcoded_spacing'), 'Missing hardcoded spacing rule');
  assert(content.includes('hardcoded_typography'), 'Missing hardcoded typography rule');
});

test('design.yaml covers accessibility', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('accessibility'), 'Missing accessibility rule');
  assert(content.includes('WCAG'), 'Must reference WCAG');
});

test('design.yaml covers dark mode', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('dark_mode'), 'Missing dark mode rule');
});

test('design.yaml covers token publishing', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/rules/design.yaml'), 'utf8');
  assert(content.includes('publish_after_changes'), 'Missing publish rule');
  assert(content.includes('shared memory'), 'Must reference shared memory');
});

// =========================================================================
// 3. Component Audit Script
// =========================================================================

console.log('\n--- Component Audit Script ---');

test('audit-tokens.js exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'design/scripts/audit-tokens.js')), 'File not found');
});

test('audit-tokens.js exports audit function', () => {
  const mod = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  assert(typeof mod.audit === 'function', 'Missing audit export');
  assert(typeof mod.scanFile === 'function', 'Missing scanFile export');
  assert(typeof mod.VIOLATION_PATTERNS === 'object', 'Missing VIOLATION_PATTERNS export');
});

test('audit detects hex color in sample content', () => {
  const { scanFile } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  // Create a temp file with a hardcoded color
  const tmpFile = path.join(ROOT, 'tests/.tmp-audit-test.tsx');
  fs.writeFileSync(tmpFile, '<div style={{ color: "#ff0000" }}>test</div>');
  try {
    const violations = scanFile(tmpFile);
    assert(violations.length > 0, 'Should detect hardcoded hex color');
    assert(violations.some(v => v.category === 'color'), 'Should categorize as color violation');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('audit detects arbitrary Tailwind spacing', () => {
  const { scanFile } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  const tmpFile = path.join(ROOT, 'tests/.tmp-audit-test2.tsx');
  fs.writeFileSync(tmpFile, '<div className="mt-[17px] pb-[22px]">test</div>');
  try {
    const violations = scanFile(tmpFile);
    assert(violations.length >= 2, 'Should detect both spacing violations');
    assert(violations.every(v => v.category === 'spacing'), 'Should categorize as spacing');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('audit skips token definition files', () => {
  const { shouldSkip } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  // shouldSkip is not exported, test via scanDirectory behavior
  const { scanDirectory } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  const files = scanDirectory(path.join(ROOT, 'design/tokens'));
  assert(files.length === 0, 'Should skip token definition directory');
});

test('audit returns structured result', () => {
  const { audit } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  // Scan a directory that likely doesn't have UI files
  const result = audit(path.join(ROOT, 'design/tokens'));
  assert('clean' in result, 'Missing clean field');
  assert('scannedFiles' in result, 'Missing scannedFiles field');
  assert('violations' in result, 'Missing violations field');
  assert('errorCount' in result, 'Missing errorCount field');
  assert('warningCount' in result, 'Missing warningCount field');
});

test('violation patterns cover all categories', () => {
  const { VIOLATION_PATTERNS } = require(path.join(ROOT, 'design/scripts/audit-tokens.js'));
  const categories = new Set(VIOLATION_PATTERNS.map(p => p.category));
  assert(categories.has('color'), 'Missing color category');
  assert(categories.has('spacing'), 'Missing spacing category');
  assert(categories.has('typography'), 'Missing typography category');
});

// =========================================================================
// 4. Design Drift Detection
// =========================================================================

console.log('\n--- Drift Detection ---');

test('detect-drift.js exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'design/scripts/detect-drift.js')), 'File not found');
});

test('detect-drift.js exports detection functions', () => {
  const mod = require(path.join(ROOT, 'design/scripts/detect-drift.js'));
  assert(typeof mod.detectDrift === 'function', 'Missing detectDrift export');
  assert(typeof mod.checkHardcodedValues === 'function', 'Missing checkHardcodedValues export');
  assert(typeof mod.checkTokenRepublish === 'function', 'Missing checkTokenRepublish export');
  assert(typeof mod.checkGeneratedSync === 'function', 'Missing checkGeneratedSync export');
});

test('drift detection returns structured result', () => {
  const { detectDrift } = require(path.join(ROOT, 'design/scripts/detect-drift.js'));
  const result = detectDrift('HEAD');
  assert('drifted' in result, 'Missing drifted field');
  assert('changedFiles' in result, 'Missing changedFiles field');
  assert('hardcodedValues' in result, 'Missing hardcodedValues field');
  assert('stalePublish' in result, 'Missing stalePublish field');
  assert('staleGenerated' in result, 'Missing staleGenerated field');
});

test('checkTokenRepublish returns empty for no token changes', () => {
  const { checkTokenRepublish } = require(path.join(ROOT, 'design/scripts/detect-drift.js'));
  const result = checkTokenRepublish(['src/app/page.tsx', 'src/components/button.tsx']);
  assert(result.length === 0, 'Should return empty for non-token files');
});

test('checkGeneratedSync returns empty for no token changes', () => {
  const { checkGeneratedSync } = require(path.join(ROOT, 'design/scripts/detect-drift.js'));
  const result = checkGeneratedSync(['src/app/page.tsx']);
  assert(result.length === 0, 'Should return empty for non-token files');
});

// =========================================================================
// 5. Agent Memory
// =========================================================================

console.log('\n--- Agent Memory ---');

test('design agent memory directory exists', () => {
  assert(fs.existsSync(path.join(ROOT, '.claude/pilot/memory/agents/design')), 'Directory not found');
});

test('design agent preferences.json is valid', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/memory/agents/design/preferences.json'), 'utf8'));
  assert(data.agentType === 'design', 'Wrong agent type');
  assert(data.data.token_format === 'dtcg', 'Wrong token format');
  assert(Array.isArray(data.data.required_categories), 'Missing required_categories');
  assert(data.data.required_categories.length === 8, 'Must have 8 categories');
});

// =========================================================================
// 6. Policy Integration
// =========================================================================

console.log('\n--- Policy Integration ---');

test('policy.yaml has design area', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/policy.yaml'), 'utf8');
  assert(content.includes('design:'), 'Missing design area');
  assert(content.includes('design-master'), 'Missing design-master agent');
  assert(content.includes('design/**'), 'Missing design/** path pattern');
});

test('policy.yaml has design_token_change approval type', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/pilot/policy.yaml'), 'utf8');
  assert(content.includes('design_token_change'), 'Missing design_token_change approval type');
  assert(content.includes('Token validation passes'), 'Missing token validation checklist item');
  assert(content.includes('Shared memory republished'), 'Missing republish checklist item');
});

// =========================================================================
// 7. Memory Index Integration
// =========================================================================

console.log('\n--- Memory Index ---');

test('design-tokens channel exists in memory index', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/pilot/memory/index.json'), 'utf8'));
  assert(data.channels['design-tokens'], 'Missing design-tokens channel');
  assert(data.channels['design-tokens'].publisher === 'design', 'Publisher must be design');
  assert(data.channels['design-tokens'].consumers.includes('frontend'), 'Frontend must consume');
  assert(data.channels['design-tokens'].consumers.includes('review'), 'Review must consume');
});

// =========================================================================
// Summary
// =========================================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

// When run directly (not under a test runner), exit with appropriate code
if (require.main === module) {
  process.exit(failed > 0 ? 1 : 0);
} else if (failed > 0) {
  throw new Error(`${failed} test(s) failed`);
}
