/**
 * WaveRunner — Sprint 3 T5 (M1.5)
 *
 * Honors decomposition.wave_execution from agent-registry.json: dispatch
 * all tasks in wave N in parallel via orchestrator.sendTaskToAgent, then
 * block wave N+1 until every task in wave N is marked complete.
 *
 * Sprint 3 scope: pure execution scaffold. Sprint 4's auto-responder
 * will hook into this via task_complete events on the hub bus.
 */

'use strict';

class WaveRunner {
  /**
   * @param {Array<Array<{id, role, title?, description?, priority?}>>} waves
   *        Ordered list of waves. Each wave is an array of subtasks.
   * @param {string} pmSessionId
   * @param {object} [opts]
   * @param {object} [opts._orchestrator] Test seam.
   */
  constructor(waves, pmSessionId, opts = {}) {
    this.waves = Array.isArray(waves) ? waves : [];
    this.pmSessionId = pmSessionId;
    this._orchestrator = opts._orchestrator || require('./orchestrator');

    this.currentWaveIndex = 0;
    this.pending = new Set();   // task ids dispatched but not complete
    this.completed = new Set();
    this.failed = new Set();
    this.assignments = [];      // history of assignments returned by orchestrator
  }

  /** Total wave count. */
  waveCount() { return this.waves.length; }

  /** True if all waves have run AND every task in them is done/failed. */
  isComplete() {
    return this.currentWaveIndex >= this.waves.length && this.pending.size === 0;
  }

  /** True if there's an in-flight wave (pending non-empty). */
  isInFlight() {
    return this.pending.size > 0;
  }

  /**
   * Dispatch every task in the current wave via sendTaskToAgent.
   * No-op if a wave is already in flight or all waves finished.
   * Returns the array of assignment results (one per task).
   */
  dispatchCurrentWave() {
    if (this.isInFlight() || this.isComplete()) return [];
    const wave = this.waves[this.currentWaveIndex];
    if (!Array.isArray(wave) || wave.length === 0) {
      // Skip empty waves and advance.
      this.currentWaveIndex += 1;
      return this.dispatchCurrentWave();
    }
    const results = [];
    for (const task of wave) {
      const result = this._orchestrator.sendTaskToAgent(
        task.role,
        task,
        this.pmSessionId,
        { reason: `Wave ${this.currentWaveIndex + 1} dispatch` }
      );
      this.assignments.push({ wave: this.currentWaveIndex, task, result });
      if (result && result.success) {
        this.pending.add(task.id);
      } else {
        // Mark as failed-to-dispatch so wave can still advance — caller
        // sees the failure in the returned results.
        this.failed.add(task.id);
      }
      results.push(result);
    }
    // If every dispatch failed (no one available), advance immediately
    // so the runner doesn't deadlock.
    if (this.pending.size === 0) {
      this.currentWaveIndex += 1;
    }
    return results;
  }

  /**
   * Notify the runner that a previously dispatched task finished.
   * When the current wave's pending set drains, advances to the next
   * wave automatically (but does NOT dispatch — caller decides when).
   * @param {string} taskId
   * @param {boolean} [success=true]
   */
  markComplete(taskId, success = true) {
    if (!this.pending.has(taskId)) return;
    this.pending.delete(taskId);
    (success ? this.completed : this.failed).add(taskId);
    if (this.pending.size === 0) {
      this.currentWaveIndex += 1;
    }
  }

  /** Snapshot for telemetry / cockpit display. */
  snapshot() {
    return {
      totalWaves: this.waves.length,
      currentWaveIndex: this.currentWaveIndex,
      pending: Array.from(this.pending),
      completed: Array.from(this.completed),
      failed: Array.from(this.failed),
      assignments: this.assignments.slice()
    };
  }
}

module.exports = { WaveRunner };
