/**
 * PM Identity — Sprint 3 T2 (M1.5)
 *
 * Lightweight persistent log of who the PM "is" on this project.
 * Captures decompositions made, decision-type counts, and a tail of
 * recent prompts. Stored alongside soul snapshots; consumed by Studio's
 * PM Cockpit Identity section in Sprint 5.
 *
 * On-disk shape (`<projectRoot>/.claude/pilot/state/orchestrator/pm-identity.json`):
 *
 *   {
 *     version: 1,
 *     sessionId: "pm-daemon",
 *     createdAt: ISO,
 *     updatedAt: ISO,
 *     decisionCounts: { decompose: N, answer: N, defer: N },
 *     decompositions: [{ ts, prompt, count }],   // last 50
 *     recentPrompts: [{ ts, prompt }],           // last 50, dedup adjacent
 *     learnedPreferences: {}                     // free-form, future use
 *   }
 *
 * All writes are atomic via tmp-rename. Failures are non-fatal.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_DECOMPOSITIONS = 50;
const MAX_PROMPTS = 50;

class PmIdentity {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.sessionId = opts.sessionId || 'pm-daemon';
    this.identity = this._load();
  }

  _identityPath() {
    return path.join(
      this.projectRoot,
      '.claude/pilot/state/orchestrator/pm-identity.json'
    );
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._identityPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        return parsed;
      }
    } catch (e) { /* fall through to fresh */ }
    const now = new Date().toISOString();
    return {
      version: 1,
      sessionId: this.sessionId,
      createdAt: now,
      updatedAt: now,
      decisionCounts: { decompose: 0, answer: 0, defer: 0, other: 0 },
      decompositions: [],
      recentPrompts: [],
      learnedPreferences: {}
    };
  }

  _save() {
    try {
      const filePath = this._identityPath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.identity.updatedAt = new Date().toISOString();
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.identity, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (e) { /* swallow */ }
  }

  /**
   * Increment the decision counter for a verdict and persist.
   * @param {string} type — "decompose" | "answer" | "defer" | other
   */
  recordDecision(type) {
    const key = ['decompose', 'answer', 'defer'].includes(type) ? type : 'other';
    this.identity.decisionCounts[key] = (this.identity.decisionCounts[key] || 0) + 1;
    this._save();
  }

  /**
   * Record a successful decomposition with the original prompt + count.
   */
  recordDecomposition(prompt, subtaskCount) {
    this.identity.decompositions.unshift({
      ts: new Date().toISOString(),
      prompt: String(prompt).slice(0, 280),
      count: subtaskCount
    });
    if (this.identity.decompositions.length > MAX_DECOMPOSITIONS) {
      this.identity.decompositions.length = MAX_DECOMPOSITIONS;
    }
    this._save();
  }

  /**
   * Record an incoming prompt for the recent-prompts tail. De-dupes
   * adjacent identical prompts so spam doesn't fill the buffer.
   */
  recordPrompt(prompt) {
    const trimmed = String(prompt).slice(0, 280);
    const last = this.identity.recentPrompts[0];
    if (last && last.prompt === trimmed) return;
    this.identity.recentPrompts.unshift({
      ts: new Date().toISOString(),
      prompt: trimmed
    });
    if (this.identity.recentPrompts.length > MAX_PROMPTS) {
      this.identity.recentPrompts.length = MAX_PROMPTS;
    }
    this._save();
  }

  setPreference(key, value) {
    this.identity.learnedPreferences[key] = value;
    this._save();
  }

  /**
   * Read a snapshot of the current identity (deep clone so callers
   * can't mutate internal state).
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this.identity));
  }
}

module.exports = { PmIdentity, MAX_DECOMPOSITIONS, MAX_PROMPTS };
