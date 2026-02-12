/**
 * Task Auto-Decomposition Engine
 *
 * Takes a large task and breaks it into subtasks with a dependency DAG.
 * Supports code-aware dependency detection via import graph analysis.
 *
 * Part of Phase 3.3 — Task Auto-Decomposition (Pilot AGI-coo)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pmResearch = require('./pm-research');
const memory = require('./memory');

// ============================================================================
// CONSTANTS
// ============================================================================

const DECOMPOSITION_CHANNEL = 'task-decompositions';
const MAX_SUBTASKS = 10;
const MAX_PARALLEL_SUBTASKS = 4;
const MIN_SUBTASKS_FOR_DECOMPOSITION = 3;
const MAX_RECURSION_DEPTH = 2;
const REDECOMPOSE_FILE_THRESHOLD = 5;

// Domain patterns mapped from agent-registry.json orchestration section
const DOMAIN_PATTERNS = {
  full_stack: {
    keywords: ['full-stack', 'fullstack', 'feature', 'page', 'profile', 'dashboard', 'settings'],
    requires: ['frontend', 'backend'],
    postAgents: ['testing', 'review']
  },
  api_only: {
    keywords: ['api', 'endpoint', 'rest', 'graphql', 'crud', 'server action', 'route', 'middleware'],
    requires: ['backend'],
    postAgents: ['security', 'testing']
  },
  ui_only: {
    keywords: ['component', 'ui', 'layout', 'page', 'form', 'modal', 'widget', 'dashboard widget', 'style', 'css'],
    requires: ['frontend'],
    postAgents: ['testing']
  },
  refactor: {
    keywords: ['refactor', 'migrate', 'redesign', 'replace', 'upgrade', 'move', 'rename'],
    requires: ['backend', 'frontend'],
    postAgents: ['testing', 'review']
  },
  design_system: {
    keywords: ['design token', 'design system', 'token', 'theme', 'color palette', 'typography'],
    requires: ['design'],
    postAgents: ['frontend', 'review']
  },
  infrastructure: {
    keywords: ['hook', 'engine', 'module', 'library', 'protocol', 'bus', 'messaging', 'memory', 'session'],
    requires: ['backend'],
    postAgents: ['testing']
  }
};

// ============================================================================
// DECOMPOSITION DECISION
// ============================================================================

/**
 * Decide whether a task should be decomposed.
 *
 * @param {object} task - { id, title, description, labels }
 * @returns {{ decompose: boolean, reason: string }}
 */
function shouldDecompose(task) {
  const complexity = pmResearch.classifyTaskComplexity(task);

  if (complexity === 'S') {
    return { decompose: false, reason: 'Simple task — no decomposition needed' };
  }

  if (complexity === 'L') {
    return { decompose: true, reason: 'Large task — decomposition required' };
  }

  // M — optional: decompose if multi-domain or many files expected
  const domain = classifyTaskDomain(task);
  if (domain.requires && domain.requires.length > 1) {
    return { decompose: true, reason: 'Medium task spanning multiple domains' };
  }

  return { decompose: false, reason: 'Medium single-domain task — decomposition optional' };
}

// ============================================================================
// DOMAIN CLASSIFICATION
// ============================================================================

/**
 * Classify the domain of a task based on keywords.
 *
 * @param {object} task - { id, title, description, labels }
 * @returns {{ domain: string, requires: string[], postAgents: string[], confidence: number }}
 */
function classifyTaskDomain(task) {
  const text = `${task.title || ''} ${task.description || ''} ${(task.labels || []).join(' ')}`.toLowerCase();

  let bestDomain = null;
  let bestScore = 0;

  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    const hits = pattern.keywords.filter(kw => text.includes(kw)).length;
    const score = pattern.keywords.length > 0 ? hits / pattern.keywords.length : 0;

    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  if (!bestDomain || bestScore === 0) {
    // Default to infrastructure for internal tooling projects
    return {
      domain: 'infrastructure',
      requires: ['backend'],
      postAgents: ['testing'],
      confidence: 0
    };
  }

  const pattern = DOMAIN_PATTERNS[bestDomain];
  return {
    domain: bestDomain,
    requires: pattern.requires,
    postAgents: pattern.postAgents,
    confidence: Math.round(bestScore * 100) / 100
  };
}

// ============================================================================
// SUBTASK GENERATION
// ============================================================================

/**
 * Generate subtasks for a task based on its domain and research context.
 *
 * @param {object} task - { id, title, description, labels }
 * @param {{ domain: string, requires: string[], postAgents: string[] }} domainInfo
 * @param {object|null} research - research context from pm-research
 * @returns {object[]} - array of subtask objects following subtask.yaml schema
 */
function generateSubtasks(task, domainInfo, research) {
  const subtasks = [];
  let stIndex = 1;

  const text = `${task.title || ''} ${task.description || ''}`;
  const relevantFiles = (research && research.relevant_files) || [];

  // Wave 1: Foundation subtasks (types, schema, config)
  if (domainInfo.requires.includes('backend') || domainInfo.domain === 'full_stack') {
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Define types and interfaces for ${extractFeatureName(task)}`,
      description: `Create TypeScript types and interfaces needed by this feature. Based on: ${text.substring(0, 200)}`,
      agent: 'backend',
      priority: 'high',
      inputs: [],
      outputs: extractTypeOutputs(task, relevantFiles),
      depends_on: [],
      wave: 1
    });
  }

  if (domainInfo.requires.includes('frontend') && domainInfo.domain !== 'api_only') {
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Create layout/structure for ${extractFeatureName(task)}`,
      description: `Set up the base layout and file structure for the UI parts of this feature.`,
      agent: 'frontend',
      priority: 'high',
      inputs: [{ name: 'design_tokens', source: 'context:design_tokens', required: false }],
      outputs: extractLayoutOutputs(task, relevantFiles),
      depends_on: [],
      wave: 1
    });
  }

  // Wave 2: Implementation subtasks (components, endpoints, services)
  const wave1Ids = subtasks.map(s => s.id);
  const typeSubtaskId = subtasks.find(s => s.agent === 'backend' && s.wave === 1)?.id;

  if (domainInfo.requires.includes('frontend') && domainInfo.domain !== 'api_only') {
    const componentSubtasks = generateComponentSubtasks(task, relevantFiles, stIndex, typeSubtaskId);
    componentSubtasks.forEach(s => {
      s.wave = 2;
      subtasks.push(s);
      stIndex++;
    });
  }

  if (domainInfo.requires.includes('backend')) {
    const apiSubtasks = generateApiSubtasks(task, relevantFiles, stIndex, typeSubtaskId);
    apiSubtasks.forEach(s => {
      s.wave = 2;
      subtasks.push(s);
      stIndex++;
    });
  }

  if (domainInfo.requires.includes('design')) {
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Design token updates for ${extractFeatureName(task)}`,
      description: `Update or create design tokens needed for this feature.`,
      agent: 'design',
      priority: 'medium',
      inputs: [{ name: 'design_tokens', source: 'context:design_tokens', required: true }],
      outputs: [],
      depends_on: [],
      wave: 2
    });
  }

  // Wave 3: Integration
  const wave2Ids = subtasks.filter(s => s.wave === 2).map(s => s.id);
  if (wave2Ids.length > 1 || (wave1Ids.length > 0 && wave2Ids.length > 0)) {
    const integrationAgent = domainInfo.requires.includes('frontend') ? 'frontend' : 'backend';
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Integrate ${extractFeatureName(task)} components`,
      description: `Wire together all created components, APIs, and services. Ensure end-to-end flow works.`,
      agent: integrationAgent,
      priority: 'high',
      inputs: wave2Ids.map(id => ({ name: `output_${id}`, source: `subtask:${id}`, required: true })),
      outputs: [],
      depends_on: [...wave1Ids, ...wave2Ids],
      wave: 3
    });
  }

  // Post-work: Testing (always added if there are implementation subtasks)
  const allImplIds = subtasks.map(s => s.id);
  if (domainInfo.postAgents.includes('testing') && allImplIds.length > 0) {
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Write tests for ${extractFeatureName(task)}`,
      description: `Write unit and integration tests covering the implemented feature.`,
      agent: 'testing',
      priority: 'medium',
      inputs: allImplIds.map(id => ({ name: `source_${id}`, source: `subtask:${id}`, required: false })),
      outputs: [],
      depends_on: allImplIds,
      wave: 4
    });
  }

  // Post-work: Security audit (if in postAgents)
  if (domainInfo.postAgents.includes('security') && allImplIds.length > 0) {
    subtasks.push({
      id: `st-${String(stIndex++).padStart(3, '0')}`,
      title: `Security audit for ${extractFeatureName(task)}`,
      description: `Review implemented code for security vulnerabilities.`,
      agent: 'security',
      priority: 'medium',
      inputs: [],
      outputs: [],
      depends_on: allImplIds,
      wave: 4
    });
  }

  // Enforce max subtasks
  return subtasks.slice(0, MAX_SUBTASKS);
}

// ============================================================================
// DEPENDENCY DAG
// ============================================================================

/**
 * Build a dependency DAG from subtasks, perform topological sort,
 * detect cycles, and group into execution waves.
 *
 * @param {object[]} subtasks - array of subtask objects with depends_on arrays
 * @returns {{ sorted: string[], waves: string[][], hasCycle: boolean, edges: [string, string][] }}
 */
function buildDependencyDAG(subtasks) {
  const nodes = new Set(subtasks.map(s => s.id));
  const edges = [];
  const inDegree = {};
  const adjacency = {};

  // Initialize
  for (const st of subtasks) {
    inDegree[st.id] = 0;
    adjacency[st.id] = [];
  }

  // Build edges
  for (const st of subtasks) {
    for (const dep of (st.depends_on || [])) {
      if (nodes.has(dep)) {
        adjacency[dep].push(st.id);
        inDegree[st.id]++;
        edges.push([dep, st.id]);
      }
    }
  }

  // Kahn's algorithm for topological sort + cycle detection
  const queue = [];
  for (const [id, deg] of Object.entries(inDegree)) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);

    for (const neighbor of adjacency[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  const hasCycle = sorted.length !== nodes.size;

  // Group into waves (BFS layers by dependency depth)
  const waves = [];
  if (!hasCycle) {
    const depth = {};
    for (const st of subtasks) {
      if ((st.depends_on || []).length === 0) {
        depth[st.id] = 0;
      }
    }

    // Compute depth for each node based on max dependency depth + 1
    for (const id of sorted) {
      if (depth[id] === undefined) {
        const st = subtasks.find(s => s.id === id);
        const maxDepDep = Math.max(...(st.depends_on || []).map(d => depth[d] ?? 0));
        depth[id] = maxDepDep + 1;
      }
    }

    // Group by depth
    const waveMap = {};
    for (const [id, d] of Object.entries(depth)) {
      if (!waveMap[d]) waveMap[d] = [];
      waveMap[d].push(id);
    }

    const maxWave = Math.max(...Object.keys(waveMap).map(Number));
    for (let i = 0; i <= maxWave; i++) {
      waves.push(waveMap[i] || []);
    }
  }

  return { sorted, waves, hasCycle, edges };
}

// ============================================================================
// CODE-AWARE DEPENDENCY DETECTION
// ============================================================================

/**
 * Analyze import/require statements in JS/TS files to build an adjacency map.
 * Returns a map of file -> [files it imports from].
 *
 * @param {string[]} files - file paths to analyze (relative to projectRoot)
 * @param {string} projectRoot - absolute path to project root
 * @returns {object} - { adjacency: { file: [imported_files] }, errors: string[] }
 */
function analyzeImportGraph(files, projectRoot) {
  const adjacency = {};
  const errors = [];

  // Regex patterns for JS/TS imports
  const importPatterns = [
    // import x from 'path'  /  import { x } from 'path'  /  import * as x from 'path'
    /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
    // require('path')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // dynamic import('path')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const file of files) {
    const absPath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    adjacency[file] = [];

    try {
      if (!fs.existsSync(absPath)) continue;

      const content = fs.readFileSync(absPath, 'utf8');

      for (const pattern of importPatterns) {
        // Reset lastIndex for each file
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const importPath = match[1];

          // Skip node_modules / external packages
          if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

          // Resolve relative import to file path
          const resolved = resolveImportPath(importPath, file, projectRoot);
          if (resolved) {
            adjacency[file].push(resolved);
          }
        }
      }
    } catch (e) {
      errors.push(`Error reading ${file}: ${e.message}`);
    }
  }

  return { adjacency, errors };
}

/**
 * Resolve a relative import path to an actual file path.
 */
function resolveImportPath(importPath, fromFile, projectRoot) {
  const dir = path.dirname(fromFile);
  const resolved = path.normalize(path.join(dir, importPath));

  // Try common extensions
  const extensions = ['', '.js', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts', '/index.tsx'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    const absCandidate = path.join(projectRoot, candidate);
    if (fs.existsSync(absCandidate)) {
      return candidate;
    }
  }

  return resolved; // Return as-is if not found (may be aliased)
}

/**
 * Detect subtasks that write to the same output files (conflict risk).
 *
 * @param {object[]} subtasks - array of subtask objects with outputs
 * @returns {{ conflicts: Array<{ file: string, subtasks: string[] }>, hasConflicts: boolean }}
 */
function detectSharedFiles(subtasks) {
  const fileMap = {};

  for (const st of subtasks) {
    for (const output of (st.outputs || [])) {
      const filePath = output.path || output;
      if (!fileMap[filePath]) fileMap[filePath] = [];
      fileMap[filePath].push(st.id);
    }
  }

  const conflicts = [];
  for (const [file, stIds] of Object.entries(fileMap)) {
    if (stIds.length > 1) {
      conflicts.push({ file, subtasks: stIds });
    }
  }

  return { conflicts, hasConflicts: conflicts.length > 0 };
}

/**
 * Infer code-level dependencies between subtasks by combining
 * import graph analysis and shared file detection.
 *
 * @param {object[]} subtasks - array of subtask objects
 * @param {string} projectRoot - absolute path to project root
 * @returns {Array<{ from: string, to: string, reason: string }>}
 */
function inferCodeDependencies(subtasks, projectRoot) {
  const inferred = [];

  // Collect all output files per subtask
  const outputMap = {};
  for (const st of subtasks) {
    for (const output of (st.outputs || [])) {
      const filePath = output.path || output;
      outputMap[filePath] = st.id;
    }
  }

  // Collect all input sources per subtask
  const inputFiles = {};
  for (const st of subtasks) {
    inputFiles[st.id] = [];
    for (const input of (st.inputs || [])) {
      if (input.source && input.source.startsWith('file:')) {
        inputFiles[st.id].push(input.source.replace('file:', ''));
      }
    }
  }

  // Analyze import graph for output files
  const allOutputFiles = Object.keys(outputMap);
  if (allOutputFiles.length > 0) {
    const { adjacency } = analyzeImportGraph(allOutputFiles, projectRoot);

    // If subtask A's output imports subtask B's output, A depends on B
    for (const [file, imports] of Object.entries(adjacency)) {
      const stId = outputMap[file];
      if (!stId) continue;

      for (const imported of imports) {
        const depStId = outputMap[imported];
        if (depStId && depStId !== stId) {
          inferred.push({
            from: depStId,
            to: stId,
            reason: `${file} imports ${imported}`
          });
        }
      }
    }
  }

  // Check input files: if subtask A needs a file that subtask B produces, A depends on B
  for (const st of subtasks) {
    for (const inputFile of (inputFiles[st.id] || [])) {
      const producerId = outputMap[inputFile];
      if (producerId && producerId !== st.id) {
        inferred.push({
          from: producerId,
          to: st.id,
          reason: `${st.id} needs file produced by ${producerId}`
        });
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return inferred.filter(dep => {
    const key = `${dep.from}->${dep.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cross-check PM-declared dependencies against code-detected dependencies.
 *
 * @param {Array<[string, string]>} declaredDeps - [[from, to], ...] from DAG edges
 * @param {Array<{ from: string, to: string, reason: string }>} codeDeps - from inferCodeDependencies
 * @returns {{ missing: Array, spurious: Array, validated: Array }}
 */
function validateDependencies(declaredDeps, codeDeps) {
  const declaredSet = new Set(declaredDeps.map(([from, to]) => `${from}->${to}`));
  const codeSet = new Set(codeDeps.map(d => `${d.from}->${d.to}`));

  const missing = codeDeps.filter(d => !declaredSet.has(`${d.from}->${d.to}`));
  const spurious = declaredDeps
    .filter(([from, to]) => !codeSet.has(`${from}->${to}`))
    .map(([from, to]) => ({ from, to, reason: 'Declared but not detected in code' }));
  const validated = declaredDeps
    .filter(([from, to]) => codeSet.has(`${from}->${to}`))
    .map(([from, to]) => {
      const codeDep = codeDeps.find(d => d.from === from && d.to === to);
      return { from, to, reason: codeDep ? codeDep.reason : 'Validated' };
    });

  return { missing, spurious, validated };
}

// ============================================================================
// BD SUBTASK CREATION
// ============================================================================

/**
 * Create subtasks in bd with parent links and dependency edges.
 *
 * @param {string} parentTaskId - parent bd task ID
 * @param {object[]} subtasks - array of subtask objects
 * @param {string} projectRoot - absolute path to project root
 * @returns {{ success: boolean, idMap: object, created: number, errors: string[] }}
 */
function createSubtasksInBd(parentTaskId, subtasks, projectRoot) {
  const idMap = {}; // st-xxx -> bd ID
  const errors = [];
  let created = 0;

  for (const st of subtasks) {
    try {
      const title = st.title.replace(/"/g, '\\"');
      const labels = ['subtask', st.agent, `parent:${parentTaskId}`].join(',');
      const priorityMap = { critical: 0, high: 1, medium: 2, low: 3 };
      const priority = priorityMap[st.priority] || 2;

      const args = [
        'create',
        '--title', `${title}`,
        '--label', labels,
        '--priority', String(priority)
      ];

      const output = execFileSync('bd', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // Extract task ID from bd create output
      const idMatch = output.match(/[A-Za-z0-9]+-[a-z0-9]+(?:\.[0-9]+)?/);
      if (idMatch) {
        idMap[st.id] = idMatch[0];
        created++;
      } else {
        errors.push(`Could not parse bd ID from output for ${st.id}: ${output}`);
      }
    } catch (e) {
      errors.push(`Failed to create bd task for ${st.id}: ${e.message}`);
    }
  }

  // Set up dependencies using bd dep add
  for (const st of subtasks) {
    const bdId = idMap[st.id];
    if (!bdId) continue;

    for (const depStId of (st.depends_on || [])) {
      const depBdId = idMap[depStId];
      if (!depBdId) continue;

      try {
        execFileSync('bd', ['dep', 'add', bdId, depBdId], {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) {
        errors.push(`Failed to add dep ${depBdId} -> ${bdId}: ${e.message}`);
      }
    }
  }

  return { success: errors.length === 0, idMap, created, errors };
}

/**
 * Assign an agent role to a subtask based on agent registry decomposition hints.
 *
 * @param {object} subtask - subtask with agent field
 * @param {object} registry - agent registry data
 * @returns {string} - agent role name
 */
function assignAgentToSubtask(subtask, registry) {
  if (!registry || !registry.agents) return subtask.agent || 'backend';

  const agentData = registry.agents[subtask.agent];
  if (!agentData) return subtask.agent || 'backend';

  // Verify the agent supports this type of action
  const decomp = agentData.decomposition;
  if (!decomp) return subtask.agent;

  // Check if subtask title matches any atomic action
  const title = subtask.title.toLowerCase();
  const actions = decomp.atomic_actions || [];
  const hasMatch = actions.some(action => {
    const actionWords = action.replace(/_/g, ' ').toLowerCase();
    return title.includes(actionWords) || actionWords.split(' ').some(w => title.includes(w));
  });

  return hasMatch ? subtask.agent : subtask.agent; // Keep assigned agent (validation only)
}

// ============================================================================
// RE-DECOMPOSITION
// ============================================================================

/**
 * Check if a subtask is too large and should be re-decomposed.
 * Criteria: too many output files, or description suggests multi-step work.
 *
 * @param {object} subtask - subtask object
 * @param {number} [depth=0] - current recursion depth
 * @returns {{ shouldSplit: boolean, reason: string }}
 */
function checkReDecomposition(subtask, depth) {
  if (depth === undefined) depth = 0;

  // Enforce recursion depth limit
  if (depth >= MAX_RECURSION_DEPTH) {
    return { shouldSplit: false, reason: 'Max recursion depth reached' };
  }

  // Check output file count
  const outputCount = (subtask.outputs || []).length;
  if (outputCount > REDECOMPOSE_FILE_THRESHOLD) {
    return {
      shouldSplit: true,
      reason: `Subtask has ${outputCount} output files (threshold: ${REDECOMPOSE_FILE_THRESHOLD})`
    };
  }

  // Check description complexity
  const desc = `${subtask.title || ''} ${subtask.description || ''}`;
  const complexityIndicators = ['and', 'also', 'plus', 'additionally', 'as well as', 'along with'];
  const indicatorCount = complexityIndicators.filter(ind => desc.toLowerCase().includes(ind)).length;
  if (indicatorCount >= 3) {
    return {
      shouldSplit: true,
      reason: `Subtask description contains ${indicatorCount} complexity indicators`
    };
  }

  return { shouldSplit: false, reason: 'Subtask is appropriately sized' };
}

/**
 * Re-decompose an oversized subtask into smaller sub-subtasks.
 *
 * @param {object} subtask - the oversized subtask
 * @param {number} depth - current recursion depth
 * @returns {object[]} - array of smaller subtasks (or original if no split needed)
 */
function reDecompose(subtask, depth) {
  if (depth === undefined) depth = 0;

  const check = checkReDecomposition(subtask, depth);
  if (!check.shouldSplit) {
    return [subtask];
  }

  // Split by output files: group outputs into chunks
  const outputs = subtask.outputs || [];
  const chunkSize = Math.ceil(outputs.length / 2);
  const chunks = [];
  for (let i = 0; i < outputs.length; i += chunkSize) {
    chunks.push(outputs.slice(i, i + chunkSize));
  }

  // If we only got 1 chunk (not enough to split), return original
  if (chunks.length <= 1) {
    return [subtask];
  }

  const subSubtasks = chunks.map((chunk, idx) => {
    const newSt = {
      id: `${subtask.id}.${idx + 1}`,
      title: `${subtask.title} (part ${idx + 1}/${chunks.length})`,
      description: subtask.description,
      agent: subtask.agent,
      priority: subtask.priority,
      inputs: subtask.inputs || [],
      outputs: chunk,
      depends_on: idx === 0 ? (subtask.depends_on || []) : [`${subtask.id}.${idx}`],
      wave: subtask.wave
    };
    return newSt;
  });

  // Recursively check each sub-subtask
  const result = [];
  for (const sst of subSubtasks) {
    const recursed = reDecompose(sst, depth + 1);
    result.push(...recursed);
  }

  return result;
}

// ============================================================================
// SHARED MEMORY PUBLISHING
// ============================================================================

const MAX_DECOMPOSITIONS = 20;

/**
 * Publish a decomposition result to the shared memory channel.
 * Other agents can query this to understand task structure.
 *
 * @param {string} parentTaskId - parent task ID
 * @param {object[]} subtasks - array of subtask objects
 * @param {object} dag - DAG from buildDependencyDAG
 */
function publishDecomposition(parentTaskId, subtasks, dag) {
  try {
    let channelData;
    try {
      channelData = memory.read(DECOMPOSITION_CHANNEL);
    } catch (e) {
      channelData = null;
    }

    const existing = channelData?.data || { decompositions: [] };
    if (!existing.decompositions) existing.decompositions = [];

    const entry = {
      task_id: parentTaskId,
      ts: new Date().toISOString(),
      subtask_count: subtasks.length,
      subtasks: subtasks.map(s => ({
        id: s.id,
        title: s.title,
        agent: s.agent,
        priority: s.priority,
        depends_on: s.depends_on || [],
        wave: s.wave
      })),
      dag: {
        nodes: dag.sorted,
        edges: dag.edges,
        waves: dag.waves,
        hasCycle: dag.hasCycle
      }
    };

    // Replace existing for same task, or append
    const idx = existing.decompositions.findIndex(d => d.task_id === parentTaskId);
    if (idx >= 0) {
      existing.decompositions[idx] = entry;
    } else {
      existing.decompositions.push(entry);
    }

    // Keep bounded
    if (existing.decompositions.length > MAX_DECOMPOSITIONS) {
      existing.decompositions = existing.decompositions.slice(-MAX_DECOMPOSITIONS);
    }

    memory.publish(DECOMPOSITION_CHANNEL, existing, {
      agent: 'pm',
      summary: `Decomposed ${parentTaskId} into ${subtasks.length} subtasks`
    });
  } catch (e) {
    // Best effort — don't break operations if publish fails
  }
}

/**
 * Read decomposition for a task from shared memory.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
function getDecomposition(taskId) {
  try {
    const channelData = memory.read(DECOMPOSITION_CHANNEL);
    if (!channelData?.data?.decompositions) return null;
    return channelData.data.decompositions.find(d => d.task_id === taskId) || null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Decompose a task into subtasks with dependency DAG.
 *
 * @param {object} task - { id, title, description, labels }
 * @param {string} projectRoot - absolute path to project root
 * @returns {{ decomposed: boolean, subtasks: object[], dag: object, domain: object, reason: string }}
 */
function decomposeTask(task, projectRoot) {
  // 1. Check if decomposition is needed
  const decision = shouldDecompose(task);
  if (!decision.decompose) {
    return {
      decomposed: false,
      subtasks: [],
      dag: null,
      domain: null,
      reason: decision.reason
    };
  }

  // 2. Classify domain
  const domainInfo = classifyTaskDomain(task);

  // 3. Get research context
  let research = null;
  try {
    research = pmResearch.buildResearchContext(task.id);
  } catch (e) {
    // Research may not be available — continue without it
  }

  // 4. Generate subtasks
  const subtasks = generateSubtasks(task, domainInfo, research);

  // 5. Build dependency DAG
  const dag = buildDependencyDAG(subtasks);

  if (dag.hasCycle) {
    // This shouldn't happen with our generator, but be safe
    return {
      decomposed: false,
      subtasks: [],
      dag,
      domain: domainInfo,
      reason: 'Cycle detected in dependency graph — decomposition aborted'
    };
  }

  // 6. Publish to shared memory
  publishDecomposition(task.id, subtasks, dag);

  return {
    decomposed: true,
    subtasks,
    dag,
    domain: domainInfo,
    reason: decision.reason
  };
}

// ============================================================================
// SUBTASK GENERATION HELPERS
// ============================================================================

/**
 * Extract a short feature name from the task for subtask titles.
 */
function extractFeatureName(task) {
  const title = task.title || task.id;
  // Remove common prefixes like [Phase X.Y] or bracketed labels
  return title.replace(/\[.*?\]\s*/g, '').trim().substring(0, 60) || task.id;
}

/**
 * Extract type-related output paths from relevant files.
 */
function extractTypeOutputs(task, relevantFiles) {
  const typeFiles = relevantFiles.filter(f =>
    f.includes('types') || f.includes('interfaces') || f.endsWith('.d.ts')
  );
  if (typeFiles.length > 0) {
    return typeFiles.slice(0, 3).map(f => ({ path: f, type: 'schema' }));
  }
  return [{ path: 'src/types/{feature}.ts', type: 'schema' }];
}

/**
 * Extract layout-related output paths from relevant files.
 */
function extractLayoutOutputs(task, relevantFiles) {
  const layoutFiles = relevantFiles.filter(f =>
    f.includes('layout') || f.includes('page') || f.includes('/app/')
  );
  if (layoutFiles.length > 0) {
    return layoutFiles.slice(0, 2).map(f => ({ path: f, type: 'react_component' }));
  }
  return [{ path: 'src/app/{feature}/page.tsx', type: 'react_component' }];
}

/**
 * Generate component subtasks based on task description.
 */
function generateComponentSubtasks(task, relevantFiles, startIndex, typeSubtaskId) {
  const subtasks = [];
  const componentFiles = relevantFiles.filter(f =>
    f.includes('component') || f.endsWith('.tsx') || f.endsWith('.jsx')
  );

  // Create at least one component subtask
  const count = Math.min(Math.max(1, Math.ceil(componentFiles.length / 2)), 3);

  for (let i = 0; i < count; i++) {
    const deps = typeSubtaskId ? [typeSubtaskId] : [];
    subtasks.push({
      id: `st-${String(startIndex + i).padStart(3, '0')}`,
      title: componentFiles[i]
        ? `Create/update ${path.basename(componentFiles[i], path.extname(componentFiles[i]))} component`
        : `Create component ${i + 1} for ${extractFeatureName(task)}`,
      description: `Implement UI component for this feature.`,
      agent: 'frontend',
      priority: 'medium',
      inputs: typeSubtaskId
        ? [{ name: 'types', source: `subtask:${typeSubtaskId}`, required: false }]
        : [],
      outputs: componentFiles[i]
        ? [{ path: componentFiles[i], type: 'react_component' }]
        : [],
      depends_on: deps
    });
  }

  return subtasks;
}

/**
 * Generate API subtasks based on task description.
 */
function generateApiSubtasks(task, relevantFiles, startIndex, typeSubtaskId) {
  const subtasks = [];
  const apiFiles = relevantFiles.filter(f =>
    f.includes('api') || f.includes('route') || f.includes('server') || f.includes('service')
  );

  const count = Math.min(Math.max(1, apiFiles.length), 3);

  for (let i = 0; i < count; i++) {
    const deps = typeSubtaskId ? [typeSubtaskId] : [];
    subtasks.push({
      id: `st-${String(startIndex + i).padStart(3, '0')}`,
      title: apiFiles[i]
        ? `Create/update ${path.basename(apiFiles[i], path.extname(apiFiles[i]))} endpoint`
        : `Create API endpoint ${i + 1} for ${extractFeatureName(task)}`,
      description: `Implement API endpoint or server-side logic for this feature.`,
      agent: 'backend',
      priority: 'medium',
      inputs: typeSubtaskId
        ? [{ name: 'types', source: `subtask:${typeSubtaskId}`, required: false }]
        : [],
      outputs: apiFiles[i]
        ? [{ path: apiFiles[i], type: 'api_route' }]
        : [],
      depends_on: deps
    });
  }

  return subtasks;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Decision
  shouldDecompose,

  // Classification
  classifyTaskDomain,

  // Generation
  generateSubtasks,

  // DAG
  buildDependencyDAG,

  // Main entry
  decomposeTask,

  // Shared memory
  publishDecomposition,
  getDecomposition,

  // Re-decomposition
  checkReDecomposition,
  reDecompose,

  // BD subtask creation
  createSubtasksInBd,
  assignAgentToSubtask,

  // Code-aware dependency detection
  analyzeImportGraph,
  detectSharedFiles,
  inferCodeDependencies,
  validateDependencies,

  // Helpers (exported for testing)
  extractFeatureName,

  // Constants
  DECOMPOSITION_CHANNEL,
  MAX_SUBTASKS,
  MAX_PARALLEL_SUBTASKS,
  MIN_SUBTASKS_FOR_DECOMPOSITION,
  MAX_RECURSION_DEPTH,
  REDECOMPOSE_FILE_THRESHOLD,
  DOMAIN_PATTERNS
};
