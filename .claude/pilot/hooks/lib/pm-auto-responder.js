/**
 * PM Auto-Responder — Sprint 4 T5 (M1.5)
 *
 * When pm_mode === 'free_chat', this loop periodically scans a queue
 * of pending chat requests and routes them through PmBrain.ask() so
 * PM responds without an explicit `should-decompose` call from Studio.
 *
 * The "queue" is a JSONL file at
 *   <projectRoot>/.claude/pilot/state/orchestrator/pm-pending-chats.jsonl
 *
 * Each line: { id, sessionId, prompt, requestedAt, ... }
 *
 * When PM answers, we append the result to a sibling file
 *   <projectRoot>/.claude/pilot/state/orchestrator/pm-chat-responses.jsonl
 *
 * Studio (or any client) can produce into the pending file and
 * tail the responses file. This avoids needing a synchronous round-
 * trip when the user toggles free_chat mode.
 *
 * Stopping is idempotent. start() is a no-op when already running OR
 * when mode != free_chat.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getPmMode } = require('./pm-mode');

const DEFAULT_INTERVAL_MS = 30 * 1000; // 30s

class PmAutoResponder {
  /**
   * @param {string} projectRoot
   * @param {object} brain  Anything with `ask(sessionId, prompt, ctx)`
   * @param {object} [opts]
   * @param {number} [opts.intervalMs]
   * @param {function} [opts._setInterval]   Test seam for fake timers
   * @param {function} [opts._clearInterval]
   * @param {function} [opts._now]            Test seam for date stamping
   */
  constructor(projectRoot, brain, opts = {}) {
    this.projectRoot = projectRoot;
    this.brain = brain;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this._setInterval = opts._setInterval || setInterval;
    this._clearInterval = opts._clearInterval || clearInterval;
    this._now = opts._now || (() => new Date().toISOString());
    this._handle = null;
  }

  pendingPath() {
    return path.join(this.projectRoot, '.claude/pilot/state/orchestrator/pm-pending-chats.jsonl');
  }
  responsesPath() {
    return path.join(this.projectRoot, '.claude/pilot/state/orchestrator/pm-chat-responses.jsonl');
  }

  /** Start the periodic scan. No-op if mode != free_chat. */
  start() {
    if (this._handle) return false;
    if (getPmMode(this.projectRoot) !== 'free_chat') return false;
    this._handle = this._setInterval(() => this.tick(), this.intervalMs);
    return true;
  }

  stop() {
    if (this._handle) {
      this._clearInterval(this._handle);
      this._handle = null;
    }
  }

  isRunning() { return !!this._handle; }

  /**
   * Single sweep — drains the pending file and writes results.
   * Idempotent: each pending entry is processed at most once per call.
   * If mode flipped away from free_chat while we were running, exit
   * early without consuming the queue.
   */
  tick() {
    if (getPmMode(this.projectRoot) !== 'free_chat') return { processed: 0, mode_off: true };

    const pendingFile = this.pendingPath();
    if (!fs.existsSync(pendingFile)) return { processed: 0 };

    let lines;
    try {
      lines = fs.readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean);
    } catch (e) {
      return { processed: 0, error: e.message };
    }
    if (lines.length === 0) return { processed: 0 };

    const responses = [];
    for (const raw of lines) {
      let req;
      try { req = JSON.parse(raw); } catch { continue; }
      if (!req || !req.prompt) continue;

      let answer;
      try {
        answer = this.brain.ask(req.sessionId || 'auto', req.prompt, req.context || {});
      } catch (e) {
        answer = { success: false, error: e.message };
      }
      responses.push({
        id: req.id,
        sessionId: req.sessionId,
        respondedAt: this._now(),
        ...answer
      });
    }

    // Persist responses + drain pending atomically (truncate-and-write).
    try {
      fs.mkdirSync(path.dirname(this.responsesPath()), { recursive: true });
      fs.appendFileSync(this.responsesPath(), responses.map(r => JSON.stringify(r)).join('\n') + '\n');
      // Drain by truncating — anything that arrived between read and now
      // is lost; tradeoff for atomic state. Studio retries pending
      // entries via the response stream.
      fs.writeFileSync(pendingFile, '');
    } catch (e) { /* swallow */ }

    return { processed: responses.length };
  }
}

module.exports = { PmAutoResponder, DEFAULT_INTERVAL_MS };
