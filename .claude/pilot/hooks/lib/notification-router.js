'use strict';

/**
 * Notification Router — Phase 5.9
 *
 * Routes notifications by priority to appropriate channels.
 * Supports batch digest for low-priority notifications.
 *
 * Priority levels:
 *   critical — immediate delivery to ALL configured channels
 *   warning  — immediate delivery to primary channel only
 *   info     — batched into digest, delivered on interval
 */

const fs = require('fs');
const path = require('path');
const { createAdapters } = require('./notification-channels');

const DIGEST_STATE_DIR = '.claude/pilot/state/notifications';
const DIGEST_FILE = 'digest-queue.json';

// ============================================================================
// ROUTER
// ============================================================================

class NotificationRouter {
  /**
   * @param {object} config - From policy.yaml notifications section
   * @param {object} config.channels - Channel configs { slack: {...}, discord: {...}, ... }
   * @param {object} [config.routing] - Routing rules per event type
   * @param {number} [config.digest_interval_minutes] - Batch digest interval (default: 30)
   * @param {string} [config.primary_channel] - Primary channel name (default: 'system')
   * @param {string} [config.projectRoot] - Project root path
   */
  constructor(config = {}) {
    this.config = config;
    this.adapters = createAdapters(config.channels || {});
    this.routing = config.routing || {};
    this.digestIntervalMs = (config.digest_interval_minutes || 30) * 60 * 1000;
    this.primaryChannel = config.primary_channel || 'system';
    this.projectRoot = config.projectRoot || process.cwd();
  }

  /**
   * Route a notification to appropriate channels based on severity.
   *
   * @param {object} notification
   * @param {string} notification.title
   * @param {string} notification.body
   * @param {string} notification.severity - 'critical' | 'warning' | 'info'
   * @param {string} [notification.event] - Event type for routing override
   * @param {object} [notification.data] - Additional data
   * @returns {Promise<{results: object[], queued: boolean}>}
   */
  async route(notification) {
    const severity = notification.severity || 'info';
    const event = notification.event || '';

    // Check for event-specific routing override
    const routingOverride = this.routing[event];
    if (routingOverride) {
      return this._sendToChannels(notification, routingOverride.channels || []);
    }

    // Default priority-based routing
    switch (severity) {
      case 'critical':
        return this._sendToAllChannels(notification);
      case 'warning':
        return this._sendToPrimary(notification);
      case 'info':
      default:
        return this._queueForDigest(notification);
    }
  }

  /**
   * Send immediately to ALL configured channels.
   */
  async _sendToAllChannels(notification) {
    const results = [];
    for (const [, adapter] of this.adapters) {
      if (adapter.enabled) {
        const result = await adapter.send(notification);
        results.push(result);
      }
    }
    return { results, queued: false };
  }

  /**
   * Send immediately to primary channel only.
   */
  async _sendToPrimary(notification) {
    const adapter = this.adapters.get(this.primaryChannel);
    if (!adapter) {
      // Fallback to system
      const system = this.adapters.get('system');
      if (system) {
        const result = await system.send(notification);
        return { results: [result], queued: false };
      }
      return { results: [], queued: false };
    }
    const result = await adapter.send(notification);
    return { results: [result], queued: false };
  }

  /**
   * Send to specific named channels.
   */
  async _sendToChannels(notification, channelNames) {
    const results = [];
    for (const name of channelNames) {
      const adapter = this.adapters.get(name);
      if (adapter && adapter.enabled) {
        const result = await adapter.send(notification);
        results.push(result);
      }
    }
    return { results, queued: false };
  }

  /**
   * Queue notification for batch digest.
   */
  async _queueForDigest(notification) {
    const digestPath = this._digestPath();
    const dir = path.dirname(digestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let queue = [];
    if (fs.existsSync(digestPath)) {
      try { queue = JSON.parse(fs.readFileSync(digestPath, 'utf8')); } catch { queue = []; }
    }

    queue.push({
      ...notification,
      queued_at: new Date().toISOString()
    });

    fs.writeFileSync(digestPath, JSON.stringify(queue, null, 2));
    return { results: [], queued: true };
  }

  /**
   * Flush the digest queue — send batched notifications.
   * Called on a timer by the PM loop.
   *
   * @returns {Promise<{sent: number, results: object[]}>}
   */
  async flushDigest() {
    const digestPath = this._digestPath();
    if (!fs.existsSync(digestPath)) return { sent: 0, results: [] };

    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(digestPath, 'utf8')); } catch { return { sent: 0, results: [] }; }
    if (queue.length === 0) return { sent: 0, results: [] };

    // Clear queue immediately
    fs.writeFileSync(digestPath, '[]');

    // Build digest notification
    const digest = _buildDigest(queue);
    const results = [];

    // Send digest to primary channel
    const adapter = this.adapters.get(this.primaryChannel) || this.adapters.get('system');
    if (adapter) {
      const result = await adapter.send(digest);
      results.push(result);
    }

    return { sent: queue.length, results };
  }

  /**
   * Check if digest should be flushed based on interval.
   * @returns {boolean}
   */
  shouldFlushDigest() {
    const digestPath = this._digestPath();
    if (!fs.existsSync(digestPath)) return false;

    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(digestPath, 'utf8')); } catch { return false; }
    if (queue.length === 0) return false;

    const oldest = queue[0]?.queued_at;
    if (!oldest) return false;

    const age = Date.now() - new Date(oldest).getTime();
    return age >= this.digestIntervalMs;
  }

  /**
   * Get current digest queue size.
   * @returns {number}
   */
  getDigestQueueSize() {
    const digestPath = this._digestPath();
    if (!fs.existsSync(digestPath)) return 0;
    try {
      const queue = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
      return queue.length;
    } catch { return 0; }
  }

  _digestPath() {
    return path.resolve(this.projectRoot, DIGEST_STATE_DIR, DIGEST_FILE);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a digest notification from a queue of notifications.
 */
function _buildDigest(queue) {
  const grouped = {};
  for (const n of queue) {
    const key = n.severity || 'info';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(n);
  }

  const lines = [`**Notification Digest** (${queue.length} items)`];
  for (const [severity, items] of Object.entries(grouped)) {
    lines.push(`\n**${severity.toUpperCase()}** (${items.length}):`);
    for (const item of items.slice(0, 20)) {
      const time = item.queued_at ? new Date(item.queued_at).toLocaleTimeString() : '';
      lines.push(`- [${time}] ${item.title}`);
    }
    if (items.length > 20) {
      lines.push(`  ... and ${items.length - 20} more`);
    }
  }

  return {
    title: `Pilot AGI Digest — ${queue.length} notifications`,
    body: lines.join('\n'),
    severity: 'info',
    event: 'digest',
    data: {
      total: queue.length,
      period_start: queue[0]?.queued_at,
      period_end: queue[queue.length - 1]?.queued_at
    }
  };
}

// ============================================================================
// CONVENIENCE — Singleton router loaded from policy.yaml
// ============================================================================

let _router = null;

/**
 * Get or create the notification router from policy.yaml.
 * @param {string} [projectRoot]
 * @returns {NotificationRouter}
 */
function getRouter(projectRoot) {
  if (_router) return _router;

  const root = projectRoot || process.cwd();
  let config = {};

  try {
    const yaml = require('js-yaml');
    const policyPath = path.resolve(root, '.claude/pilot/policy.yaml');
    if (fs.existsSync(policyPath)) {
      const policy = yaml.load(fs.readFileSync(policyPath, 'utf8'));
      config = policy?.notifications || {};
    }
  } catch { /* use defaults */ }

  _router = new NotificationRouter({ ...config, projectRoot: root });
  return _router;
}

/**
 * Reset the singleton (for testing).
 */
function resetRouter() {
  _router = null;
}

/**
 * Send a notification through the router (convenience).
 * @param {object} notification
 * @returns {Promise<{results: object[], queued: boolean}>}
 */
async function notify(notification) {
  const router = getRouter();
  return router.route(notification);
}

module.exports = {
  NotificationRouter,
  getRouter,
  resetRouter,
  notify,
  _buildDigest, // exported for testing
  DIGEST_STATE_DIR
};
