/**
 * Artifact Registry (Phase 4.7)
 *
 * File-based output contracts for multi-agent coordination.
 * Agents write outputs to shared location; PM gates spawning
 * on artifact readiness. No async messaging needed — agents
 * are ephemeral processes that write during execution and
 * read at spawn time.
 *
 * State: .claude/pilot/state/artifacts/<taskId>/
 *   ├── manifest.json      - declares inputs/outputs
 *   ├── outputs/<name>     - actual artifact files
 *   └── progress.jsonl     - step-level progress entries
 *
 * Part of Phase 4.7 (Pilot AGI-y1l)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const ARTIFACTS_DIR = '.claude/pilot/state/artifacts';
const MANIFEST_FILE = 'manifest.json';
const OUTPUTS_DIR = 'outputs';
const PROGRESS_FILE = 'progress.jsonl';

// ============================================================================
// HELPERS
// ============================================================================

function artifactDir(taskId, projectRoot) {
  return path.join(projectRoot || process.cwd(), ARTIFACTS_DIR, taskId);
}

function manifestPath(taskId, projectRoot) {
  return path.join(artifactDir(taskId, projectRoot), MANIFEST_FILE);
}

function outputsDir(taskId, projectRoot) {
  return path.join(artifactDir(taskId, projectRoot), OUTPUTS_DIR);
}

function progressPath(taskId, projectRoot) {
  return path.join(artifactDir(taskId, projectRoot), PROGRESS_FILE);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ============================================================================
// MANIFEST OPERATIONS
// ============================================================================

/**
 * Get the manifest for a task. Creates empty manifest if none exists.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {{ outputs: Array<{name: string, description?: string}>, inputs: Array<{taskId: string, name: string}>, declared_at?: string }}
 */
function getManifest(taskId, projectRoot) {
  const mp = manifestPath(taskId, projectRoot);
  const manifest = readJson(mp);
  if (manifest) return manifest;
  return { outputs: [], inputs: [] };
}

/**
 * Declare what artifacts this task will produce.
 * Merges with existing manifest (additive).
 *
 * @param {string} taskId
 * @param {Array<{name: string, description?: string}>} outputs
 * @param {string} [projectRoot]
 */
function declareOutputs(taskId, outputs, projectRoot) {
  const manifest = getManifest(taskId, projectRoot);
  const existingNames = new Set(manifest.outputs.map(o => o.name));

  for (const output of outputs) {
    if (!existingNames.has(output.name)) {
      manifest.outputs.push(output);
      existingNames.add(output.name);
    }
  }

  manifest.declared_at = manifest.declared_at || new Date().toISOString();
  manifest.updated_at = new Date().toISOString();
  writeJson(manifestPath(taskId, projectRoot), manifest);
}

/**
 * Declare what artifacts this task needs from other tasks.
 * Merges with existing manifest (additive).
 *
 * @param {string} taskId
 * @param {Array<{taskId: string, name: string}>} inputs
 * @param {string} [projectRoot]
 */
function declareInputs(taskId, inputs, projectRoot) {
  const manifest = getManifest(taskId, projectRoot);
  const existingKeys = new Set(manifest.inputs.map(i => `${i.taskId}:${i.name}`));

  for (const input of inputs) {
    const key = `${input.taskId}:${input.name}`;
    if (!existingKeys.has(key)) {
      manifest.inputs.push(input);
      existingKeys.add(key);
    }
  }

  manifest.declared_at = manifest.declared_at || new Date().toISOString();
  manifest.updated_at = new Date().toISOString();
  writeJson(manifestPath(taskId, projectRoot), manifest);
}

// ============================================================================
// ARTIFACT I/O
// ============================================================================

/**
 * Publish an artifact output. Writes the content to the outputs directory.
 *
 * @param {string} taskId - Task producing the artifact
 * @param {string} name - Artifact name (e.g., "api-contract.json")
 * @param {string|object} content - Content to write (objects are JSON-serialized)
 * @param {string} [projectRoot]
 */
function publishArtifact(taskId, name, content, projectRoot) {
  const outDir = outputsDir(taskId, projectRoot);
  ensureDir(outDir);

  const filePath = path.join(outDir, name);
  const data = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  fs.writeFileSync(filePath, data);

  // Auto-declare if not already in manifest
  const manifest = getManifest(taskId, projectRoot);
  if (!manifest.outputs.some(o => o.name === name)) {
    manifest.outputs.push({ name });
    manifest.updated_at = new Date().toISOString();
    writeJson(manifestPath(taskId, projectRoot), manifest);
  }
}

/**
 * Read an artifact from a task's outputs.
 *
 * @param {string} taskId - Task that produced the artifact
 * @param {string} name - Artifact name
 * @param {string} [projectRoot]
 * @returns {string|null} Content or null if not found
 */
function readArtifact(taskId, name, projectRoot) {
  const filePath = path.join(outputsDir(taskId, projectRoot), name);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * List all published artifacts for a task.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {string[]} Array of artifact file names
 */
function listArtifacts(taskId, projectRoot) {
  const outDir = outputsDir(taskId, projectRoot);
  try {
    return fs.readdirSync(outDir).filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}

// ============================================================================
// DEPENDENCY RESOLUTION
// ============================================================================

/**
 * Check if all required input artifacts are available.
 *
 * @param {string} taskId - Task to check
 * @param {string} [projectRoot]
 * @returns {boolean}
 */
function checkArtifactsReady(taskId, projectRoot) {
  return getBlockingArtifacts(taskId, projectRoot).length === 0;
}

/**
 * Get the list of input artifacts that are NOT yet available.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {Array<{taskId: string, name: string}>} Missing artifacts
 */
function getBlockingArtifacts(taskId, projectRoot) {
  const manifest = getManifest(taskId, projectRoot);
  if (!manifest.inputs || manifest.inputs.length === 0) return [];

  const missing = [];
  for (const input of manifest.inputs) {
    const content = readArtifact(input.taskId, input.name, projectRoot);
    if (content === null) {
      missing.push({ taskId: input.taskId, name: input.name });
    }
  }
  return missing;
}

// ============================================================================
// PROGRESS TRACKING
// ============================================================================

/**
 * Record a progress entry for a task.
 *
 * @param {string} taskId
 * @param {string} step - Step name/description
 * @param {string} status - "started" | "completed" | "failed" | "skipped"
 * @param {string} [projectRoot]
 */
function recordProgress(taskId, step, status, projectRoot) {
  const pp = progressPath(taskId, projectRoot);
  ensureDir(path.dirname(pp));

  const entry = JSON.stringify({
    step,
    status,
    ts: new Date().toISOString()
  });
  fs.appendFileSync(pp, entry + '\n');
}

/**
 * Get all progress entries for a task.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 * @returns {Array<{step: string, status: string, ts: string}>}
 */
function getProgress(taskId, projectRoot) {
  const pp = progressPath(taskId, projectRoot);
  try {
    const lines = fs.readFileSync(pp, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Remove all artifacts for a completed task.
 *
 * @param {string} taskId
 * @param {string} [projectRoot]
 */
function cleanupArtifacts(taskId, projectRoot) {
  const dir = artifactDir(taskId, projectRoot);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore if directory doesn't exist
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Manifest
  getManifest,
  declareOutputs,
  declareInputs,

  // Artifact I/O
  publishArtifact,
  readArtifact,
  listArtifacts,

  // Dependency resolution
  checkArtifactsReady,
  getBlockingArtifacts,

  // Progress
  recordProgress,
  getProgress,

  // Cleanup
  cleanupArtifacts,

  // Constants (for testing)
  ARTIFACTS_DIR,
  MANIFEST_FILE,
  OUTPUTS_DIR,
  PROGRESS_FILE
};
