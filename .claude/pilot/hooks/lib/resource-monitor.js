/**
 * Resource Monitor (Phase 5.4)
 *
 * Lightweight system resource checker for pool autoscaling decisions.
 * Uses Node.js `os` module for CPU, memory, and load average metrics.
 *
 * API:
 *   getSystemResources() -> { cpuPct, memPct, processCount, loadAvg }
 *   isUnderPressure(thresholds) -> boolean
 */

const os = require('os');
const { execFileSync } = require('child_process');

// ============================================================================
// CPU USAGE
// ============================================================================

/**
 * Calculate CPU usage percentage across all cores.
 * Uses a snapshot of os.cpus() idle vs total time.
 *
 * @returns {number} CPU usage percentage (0-100)
 */
function getCpuUsage() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }

  if (totalTick === 0) return 0;

  const idlePct = (totalIdle / totalTick) * 100;
  return Math.round(100 - idlePct);
}

// ============================================================================
// MEMORY USAGE
// ============================================================================

/**
 * Calculate memory usage percentage.
 *
 * @returns {number} Memory usage percentage (0-100)
 */
function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  if (total === 0) return 0;
  return Math.round(((total - free) / total) * 100);
}

// ============================================================================
// PROCESS COUNT
// ============================================================================

/**
 * Count active Claude agent processes.
 *
 * @returns {number} Number of claude processes found
 */
function getClaudeProcessCount() {
  try {
    const output = execFileSync('pgrep', ['-f', 'claude'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (!output) return 0;
    return output.split('\n').filter(Boolean).length;
  } catch (e) {
    // pgrep returns exit code 1 if no matches
    return 0;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get current system resource metrics.
 *
 * @returns {{ cpuPct: number, memPct: number, processCount: number, loadAvg: number[] }}
 */
function getSystemResources() {
  return {
    cpuPct: getCpuUsage(),
    memPct: getMemoryUsage(),
    processCount: getClaudeProcessCount(),
    loadAvg: os.loadavg()
  };
}

/**
 * Check if the system is under resource pressure.
 *
 * @param {{ cpuThresholdPct?: number, memoryThresholdPct?: number }} [thresholds]
 * @returns {boolean}
 */
function isUnderPressure(thresholds = {}) {
  const cpuThreshold = thresholds.cpuThresholdPct || 80;
  const memThreshold = thresholds.memoryThresholdPct || 85;

  const resources = getSystemResources();
  return resources.cpuPct >= cpuThreshold || resources.memPct >= memThreshold;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  getSystemResources,
  isUnderPressure,
  getCpuUsage,
  getMemoryUsage,
  getClaudeProcessCount
};
