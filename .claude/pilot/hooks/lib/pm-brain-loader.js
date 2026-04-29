/**
 * R4 (2026-04-28) — pm-brain hot-reload loader.
 *
 * Wraps require('./pm-brain') with an fs.watch that invalidates the
 * Node module cache on file change. Subsequent calls to load() return
 * a fresh PmBrain class with the latest prompt template, no daemon
 * restart required.
 *
 * Why this exists: every prompt-engineering iteration (R1, the user's
 * "PM is dumb" → "PM gives commands not promises") required killing
 * pm-daemon.js and respawning. With per-edit cycles of 30-60s, that
 * dragged the iteration loop to a crawl and made dogfooding painful.
 *
 * Design:
 *   - Cache the loaded PmBrain constructor.
 *   - On fs.watch event, drop the cache + delete from require.cache.
 *   - Next load() does a fresh require → picks up edits.
 *   - Existing PmBrain instances are NOT swapped out — they keep the
 *     constructor they were built with. New PmBrain() invocations get
 *     the new code. This is intentional: in-flight asks complete
 *     against the prompt they started with, no mid-stream surgery.
 *
 * Usage:
 *   const loader = require('./pm-brain-loader');
 *   const PmBrain = loader.load();        // current class
 *   const brain = new PmBrain(...);
 *   loader.watch();                       // start watcher (idempotent)
 *   loader.onReload((PmBrain) => { ... }); // optional callback
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PM_BRAIN_PATH = path.resolve(__dirname, 'pm-brain.js');
const DEPS = [
  PM_BRAIN_PATH,
  path.resolve(__dirname, 'pm-knowledge-base.js'),
  path.resolve(__dirname, 'pm-identity.js')
];

let _cached = null;
let _watchers = [];
let _reloadCallbacks = [];
let _reloadCount = 0;

function _invalidate() {
  for (const dep of DEPS) {
    try { delete require.cache[require.resolve(dep)]; } catch (e) { /* ignore */ }
  }
  _cached = null;
}

/** Fresh require (or cached) of the PmBrain class. */
function load() {
  if (!_cached) {
    _cached = require('./pm-brain').PmBrain;
  }
  return _cached;
}

/** Stop and re-attach watchers. Idempotent. */
function watch() {
  unwatch();
  for (const dep of DEPS) {
    try {
      const w = fs.watch(dep, { persistent: false }, () => {
        _invalidate();
        _reloadCount += 1;
        const Fresh = load();
        for (const cb of _reloadCallbacks) {
          try { cb(Fresh); } catch (e) { /* swallow */ }
        }
      });
      _watchers.push(w);
    } catch (e) { /* file may not exist; skip */ }
  }
}

function unwatch() {
  for (const w of _watchers) {
    try { w.close(); } catch (e) { /* ignore */ }
  }
  _watchers = [];
}

/** Subscribe to reload events. Returns an unsubscribe function. */
function onReload(cb) {
  _reloadCallbacks.push(cb);
  return () => {
    _reloadCallbacks = _reloadCallbacks.filter(c => c !== cb);
  };
}

/** Test/diagnostic helpers. */
function _stats() {
  return { reloadCount: _reloadCount, watcherCount: _watchers.length, cached: _cached !== null };
}

/** Force-reload (for tests or for the /api/reload-brain endpoint). */
function forceReload() {
  _invalidate();
  _reloadCount += 1;
  const Fresh = load();
  for (const cb of _reloadCallbacks) {
    try { cb(Fresh); } catch (e) { /* swallow */ }
  }
  return Fresh;
}

module.exports = { load, watch, unwatch, onReload, forceReload, _stats, DEPS };
