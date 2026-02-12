/**
 * PM Auto-Research Module
 *
 * Provides automatic research capabilities for the PM agent.
 * Before assigning tasks, PM classifies complexity and researches
 * best practices, relevant codebase patterns, and technology needs.
 *
 * Part of Phase 3.2 — PM Auto-Research (Pilot AGI-7ne)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const memory = require('./memory');

// ============================================================================
// CONSTANTS
// ============================================================================

const RESEARCH_CHANNEL = 'research-findings';
const RESEARCH_DIR = 'work/research';
const MAX_CONTEXT_SIZE = 4000; // bytes, for task delegation message

// Complexity classification thresholds
const COMPLEXITY_THRESHOLDS = {
  descriptionLengthM: 100,  // chars: M if description > 100
  descriptionLengthL: 300,  // chars: L if description > 300
  keywordsL: ['system', 'architecture', 'redesign', 'migration', 'integration', 'protocol', 'engine', 'framework'],
  keywordsM: ['add', 'implement', 'create', 'build', 'update', 'extend', 'enhance', 'refactor']
};

// ============================================================================
// TASK COMPLEXITY CLASSIFICATION
// ============================================================================

/**
 * Classify task complexity as S (small), M (medium), or L (large).
 * Used to decide whether auto-research is needed.
 *
 * @param {object} task - { id, title, description, labels }
 * @returns {'S'|'M'|'L'}
 */
function classifyTaskComplexity(task) {
  if (!task) return 'S';

  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();
  const len = text.length;

  // Check for L keywords first
  const hasLKeyword = COMPLEXITY_THRESHOLDS.keywordsL.some(kw => text.includes(kw));
  if (hasLKeyword && len > COMPLEXITY_THRESHOLDS.descriptionLengthM) return 'L';
  if (len > COMPLEXITY_THRESHOLDS.descriptionLengthL) return 'L';

  // Check for M keywords
  const hasMKeyword = COMPLEXITY_THRESHOLDS.keywordsM.some(kw => text.includes(kw));
  if (hasMKeyword || len > COMPLEXITY_THRESHOLDS.descriptionLengthM) return 'M';

  return 'S';
}

// ============================================================================
// RESEARCH CACHE
// ============================================================================

/**
 * Check if research already exists for a task.
 * Returns cached findings or null.
 *
 * @param {string} taskId - bd task ID
 * @returns {object|null} - cached findings or null
 */
function checkResearchCache(taskId) {
  try {
    const channelData = memory.read(RESEARCH_CHANNEL);
    if (!channelData?.data?.findings) return null;

    const cached = channelData.data.findings.find(f => f.task_id === taskId);
    return cached || null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// AUTO-RESEARCH ENGINE
// ============================================================================

/**
 * Run auto-research for a task.
 * Analyzes task description, scans codebase for relevant patterns,
 * and identifies technology needs.
 *
 * @param {object} task - { id, title, description, labels }
 * @param {string} projectRoot - absolute path to project root
 * @returns {object} - research findings
 */
function runAutoResearch(task, projectRoot) {
  const text = `${task.title || ''} ${task.description || ''}`;
  const complexity = classifyTaskComplexity(task);

  // 1. Extract technology keywords from task
  const technologies = extractTechnologies(text);

  // 2. Find relevant files in codebase
  const relevantFiles = findRelevantFiles(task, projectRoot);

  // 3. Find existing patterns
  const patterns = findExistingPatterns(task, projectRoot);

  // 4. Check pattern library for related past research
  const relatedResearch = queryPatternLibrary(
    text.split(/\s+/).filter(w => w.length > 4).slice(0, 5),
    projectRoot
  );

  // 5. Build summary
  const summary = buildSummary(task, technologies, relevantFiles, patterns, relatedResearch);

  const findings = {
    task_id: task.id,
    ts: new Date().toISOString(),
    complexity,
    summary,
    recommendations: buildRecommendations(task, technologies, patterns, relevantFiles),
    technologies,
    relevant_files: relevantFiles.slice(0, 20),
    patterns
  };

  // 6. Publish to shared memory
  publishFindings(findings);

  // 7. Save to work/research/
  saveResearchFile(findings, task, projectRoot);

  return findings;
}

/**
 * Extract technology keywords from task text.
 * Matches against known tech stacks and libraries.
 */
function extractTechnologies(text) {
  const lower = text.toLowerCase();
  const techMap = {
    'react': 'UI framework',
    'next.js': 'React meta-framework',
    'nextjs': 'React meta-framework',
    'typescript': 'Type-safe JavaScript',
    'node.js': 'Server runtime',
    'nodejs': 'Server runtime',
    'prisma': 'Database ORM',
    'tailwind': 'Utility-first CSS',
    'shadcn': 'Component library',
    'vitest': 'Test framework',
    'playwright': 'E2E testing',
    'redis': 'In-memory data store',
    'postgres': 'Relational database',
    'sqlite': 'Embedded database',
    'graphql': 'API query language',
    'rest api': 'HTTP API style',
    'websocket': 'Real-time communication',
    'docker': 'Containerization',
    'auth': 'Authentication/authorization',
    'oauth': 'OAuth protocol',
    'jwt': 'JSON Web Tokens',
    'stripe': 'Payment processing',
    'webhook': 'Event callback',
    'cron': 'Scheduled jobs',
    'queue': 'Message/job queue',
    'cache': 'Caching layer'
  };

  const found = [];
  for (const [tech, reason] of Object.entries(techMap)) {
    if (lower.includes(tech)) {
      found.push({ name: tech, reason });
    }
  }
  return found;
}

/**
 * Find files relevant to this task by scanning the codebase.
 * Uses keywords from the task title/description.
 */
function findRelevantFiles(task, projectRoot) {
  const text = `${task.title || ''} ${task.description || ''}`;
  // Extract meaningful words (>4 chars, no common words)
  const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'should', 'could', 'would', 'been', 'being', 'their', 'there', 'which', 'about', 'after', 'before', 'between', 'through', 'during', 'phase', 'needs']);
  const keywords = text
    .replace(/[^a-zA-Z0-9\s-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !stopWords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());

  const uniqueKeywords = [...new Set(keywords)].slice(0, 8);
  const files = new Set();

  for (const kw of uniqueKeywords) {
    try {
      const output = execFileSync('grep', ['-rl', '--include=*.js', '--include=*.ts', '--include=*.json', '-i', kw, '.'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      output.trim().split('\n').filter(Boolean).forEach(f => files.add(f));
    } catch (e) {
      // grep returns 1 if no matches — that's fine
    }
    if (files.size > 30) break; // bound the search
  }

  return [...files].slice(0, 20);
}

/**
 * Find existing code patterns relevant to the task.
 * Looks for similar implementations in the codebase.
 */
function findExistingPatterns(task, projectRoot) {
  const patterns = [];
  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();

  // Check for existing hooks
  if (text.includes('hook') || text.includes('trigger') || text.includes('event')) {
    const hookDir = path.join(projectRoot, '.claude/pilot/hooks');
    if (fs.existsSync(hookDir)) {
      patterns.push('Existing hook pattern in .claude/pilot/hooks/');
    }
  }

  // Check for existing lib modules
  if (text.includes('module') || text.includes('library') || text.includes('engine')) {
    const libDir = path.join(projectRoot, '.claude/pilot/hooks/lib');
    if (fs.existsSync(libDir)) {
      try {
        const modules = fs.readdirSync(libDir).filter(f => f.endsWith('.js'));
        patterns.push(`Existing lib modules: ${modules.join(', ')}`);
      } catch (e) { /* ignore */ }
    }
  }

  // Check for existing memory channels
  if (text.includes('memory') || text.includes('shared') || text.includes('channel') || text.includes('store')) {
    patterns.push('Shared memory pattern: memory.publish(channel, data) / memory.read(channel)');
  }

  // Check for existing messaging patterns
  if (text.includes('message') || text.includes('bus') || text.includes('communicate') || text.includes('notify')) {
    patterns.push('Message bus pattern: messaging.send*() with ACK protocol');
  }

  // Check for existing test patterns
  if (text.includes('test')) {
    const testDir = path.join(projectRoot, 'tests');
    if (fs.existsSync(testDir)) {
      patterns.push('Test pattern: node tests/{module}.test.js with assert-based validation');
    }
  }

  return patterns;
}

// ============================================================================
// PATTERN LIBRARY & TECHNOLOGY DECISIONS
// ============================================================================

/**
 * Record a technology decision in the pattern library.
 * Persists across sessions via shared memory.
 *
 * @param {object} decision - { name, reason, task_id, alternatives_considered }
 */
function recordTechDecision(decision) {
  let channelData;
  try {
    channelData = memory.read(RESEARCH_CHANNEL);
  } catch (e) {
    channelData = null;
  }

  const existing = channelData?.data || { findings: [], tech_decisions: [] };
  if (!existing.tech_decisions) existing.tech_decisions = [];

  existing.tech_decisions.push({
    ...decision,
    ts: new Date().toISOString()
  });

  // Keep bounded (last 100 decisions)
  if (existing.tech_decisions.length > 100) {
    existing.tech_decisions = existing.tech_decisions.slice(-100);
  }

  memory.publish(RESEARCH_CHANNEL, existing, {
    agent: 'pm',
    summary: `Tech decision: ${decision.name} — ${decision.reason}`
  });
}

/**
 * Search pattern library for relevant past findings.
 *
 * @param {string[]} keywords - search terms
 * @returns {object[]} - matching findings
 */
function queryPatternLibrary(keywords, _projectRoot) {
  try {
    const channelData = memory.read(RESEARCH_CHANNEL);
    if (!channelData?.data) return [];

    const results = [];
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    // Search findings
    for (const finding of (channelData.data.findings || [])) {
      const text = `${finding.summary || ''} ${(finding.recommendations || []).join(' ')}`.toLowerCase();
      const matches = lowerKeywords.filter(kw => text.includes(kw));
      if (matches.length > 0) {
        results.push({ type: 'finding', data: finding, matches: matches.length });
      }
    }

    // Search tech decisions
    for (const decision of (channelData.data.tech_decisions || [])) {
      const text = `${decision.name} ${decision.reason}`.toLowerCase();
      const matches = lowerKeywords.filter(kw => text.includes(kw));
      if (matches.length > 0) {
        results.push({ type: 'tech_decision', data: decision, matches: matches.length });
      }
    }

    return results.sort((a, b) => b.matches - a.matches).slice(0, 5);
  } catch (e) {
    return [];
  }
}

// ============================================================================
// RESEARCH OUTPUT
// ============================================================================

/**
 * Publish findings to shared memory channel.
 */
function publishFindings(findings) {
  let channelData;
  try {
    channelData = memory.read(RESEARCH_CHANNEL);
  } catch (e) {
    channelData = null;
  }

  const existing = channelData?.data || { findings: [], tech_decisions: [] };
  if (!existing.findings) existing.findings = [];

  // Replace existing findings for same task, or append
  const idx = existing.findings.findIndex(f => f.task_id === findings.task_id);
  if (idx >= 0) {
    existing.findings[idx] = findings;
  } else {
    existing.findings.push(findings);
  }

  // Keep bounded (last 50 findings)
  if (existing.findings.length > 50) {
    existing.findings = existing.findings.slice(-50);
  }

  memory.publish(RESEARCH_CHANNEL, existing, {
    agent: 'pm',
    summary: `Research for ${findings.task_id}: ${findings.summary.substring(0, 80)}`
  });
}

/**
 * Save detailed research to work/research/{taskId}-{slug}.md
 */
function saveResearchFile(findings, task, projectRoot) {
  const researchDir = path.join(projectRoot, RESEARCH_DIR);
  if (!fs.existsSync(researchDir)) {
    fs.mkdirSync(researchDir, { recursive: true });
  }

  const slug = (task.title || task.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  const filename = `${task.id}-${slug}.md`;
  const filePath = path.join(researchDir, filename);

  const content = `# Research: ${task.title || task.id}

**Task**: ${task.id}
**Date**: ${new Date().toISOString().split('T')[0]}
**Complexity**: ${findings.complexity}

## Summary

${findings.summary}

## Recommendations

${(findings.recommendations || []).map(r => `- ${r}`).join('\n')}

## Technologies

${(findings.technologies || []).map(t => `- **${t.name}**: ${t.reason}`).join('\n') || 'None identified'}

## Relevant Files

${(findings.relevant_files || []).map(f => `- \`${f}\``).join('\n') || 'None found'}

## Patterns

${(findings.patterns || []).map(p => `- ${p}`).join('\n') || 'None found'}
`;

  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Build compact research context for task delegation message.
 * Must fit within MAX_CONTEXT_SIZE bytes.
 *
 * @param {string} taskId
 * @returns {object|null} - compact context or null if no research
 */
function buildResearchContext(taskId) {
  const cached = checkResearchCache(taskId);
  if (!cached) return null;

  const context = {
    complexity: cached.complexity,
    summary: cached.summary,
    recommendations: (cached.recommendations || []).slice(0, 5),
    technologies: (cached.technologies || []).slice(0, 5).map(t => t.name),
    relevant_files: (cached.relevant_files || []).slice(0, 10),
    patterns: (cached.patterns || []).slice(0, 3)
  };

  // Ensure it fits within size limit
  const serialized = JSON.stringify(context);
  if (serialized.length > MAX_CONTEXT_SIZE) {
    // Trim to fit
    context.relevant_files = context.relevant_files.slice(0, 5);
    context.recommendations = context.recommendations.slice(0, 3);
    context.patterns = context.patterns.slice(0, 2);
    context.summary = context.summary.substring(0, 200);
  }

  return context;
}

// ============================================================================
// HELPERS
// ============================================================================

function buildSummary(task, technologies, relevantFiles, patterns, relatedResearch) {
  const parts = [];

  if (technologies.length > 0) {
    parts.push(`Technologies involved: ${technologies.map(t => t.name).join(', ')}.`);
  }

  if (relevantFiles.length > 0) {
    parts.push(`Found ${relevantFiles.length} relevant file(s) in the codebase.`);
  }

  if (patterns.length > 0) {
    parts.push(`${patterns.length} existing pattern(s) can be reused.`);
  }

  if (relatedResearch.length > 0) {
    parts.push(`${relatedResearch.length} related past research finding(s) available.`);
  }

  if (parts.length === 0) {
    parts.push(`Task "${task.title || task.id}" — no specific patterns or technologies detected.`);
  }

  return parts.join(' ').substring(0, 500);
}

function buildRecommendations(task, technologies, patterns, relevantFiles) {
  const recs = [];

  if (patterns.length > 0) {
    recs.push(`Follow existing patterns: ${patterns[0]}`);
  }

  if (technologies.length > 0) {
    recs.push(`Use established technologies: ${technologies.map(t => t.name).join(', ')}`);
  }

  if (relevantFiles.length > 0) {
    recs.push(`Start by reviewing: ${relevantFiles.slice(0, 3).join(', ')}`);
  }

  if (recs.length === 0) {
    recs.push('No specific recommendations — standard implementation approach');
  }

  return recs;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Classification
  classifyTaskComplexity,

  // Research cache
  checkResearchCache,

  // Auto-research
  runAutoResearch,

  // Pattern library
  recordTechDecision,
  queryPatternLibrary,

  // Context building
  buildResearchContext,

  // Constants
  RESEARCH_CHANNEL,
  RESEARCH_DIR,
  MAX_CONTEXT_SIZE,
  COMPLEXITY_THRESHOLDS
};
