'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Fresh module helper
function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  // Also clear notification-channels since it's a dependency
  const channelsPath = require.resolve('../.claude/pilot/hooks/lib/notification-channels');
  delete require.cache[channelsPath];
  return require(resolved);
}

describe('notification-router', () => {
  let router;
  let tmpDir;

  beforeEach(() => {
    router = freshModule('../.claude/pilot/hooks/lib/notification-router');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-notify-'));
  });

  afterEach(() => {
    router.resetRouter();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // NOTIFICATION ROUTER CLASS
  // =========================================================================

  describe('NotificationRouter', () => {
    it('creates with default config', () => {
      const r = new router.NotificationRouter({ projectRoot: tmpDir });
      assert.ok(r.adapters.has('system')); // always present
      assert.equal(r.primaryChannel, 'system');
    });

    it('routes critical to all channels', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: {
          system: { enabled: false } // disable to avoid osascript
        }
      });
      const result = await r.route({
        title: 'Critical Alert',
        body: 'Something broke',
        severity: 'critical'
      });
      assert.equal(result.queued, false);
      // All adapters attempted (even if disabled they still return disabled result)
    });

    it('routes warning to primary channel', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: {
          system: { enabled: false }
        }
      });
      const result = await r.route({
        title: 'Warning',
        body: 'Something happened',
        severity: 'warning'
      });
      assert.equal(result.queued, false);
    });

    it('queues info for digest', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: {}
      });
      const result = await r.route({
        title: 'FYI',
        body: 'Just an info',
        severity: 'info'
      });
      assert.equal(result.queued, true);
      assert.equal(r.getDigestQueueSize(), 1);
    });

    it('queues multiple info notifications', async () => {
      const r = new router.NotificationRouter({ projectRoot: tmpDir, channels: {} });
      await r.route({ title: 'Info 1', body: 'A', severity: 'info' });
      await r.route({ title: 'Info 2', body: 'B', severity: 'info' });
      await r.route({ title: 'Info 3', body: 'C', severity: 'info' });
      assert.equal(r.getDigestQueueSize(), 3);
    });

    it('uses routing override when event matches', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: {
          system: { enabled: false }
        },
        routing: {
          'escalation_human': { channels: ['system'] }
        }
      });
      const result = await r.route({
        title: 'Human Needed',
        body: 'Escalation',
        severity: 'critical',
        event: 'escalation_human'
      });
      assert.equal(result.queued, false);
    });
  });

  // =========================================================================
  // DIGEST
  // =========================================================================

  describe('digest', () => {
    it('flushDigest sends batched items', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: { system: { enabled: false } },
        digest_interval_minutes: 0 // immediate flush for testing
      });

      await r.route({ title: 'Info 1', body: 'A', severity: 'info' });
      await r.route({ title: 'Info 2', body: 'B', severity: 'info' });

      const { sent } = await r.flushDigest();
      assert.equal(sent, 2);
      assert.equal(r.getDigestQueueSize(), 0); // queue cleared
    });

    it('flushDigest returns 0 when empty', async () => {
      const r = new router.NotificationRouter({ projectRoot: tmpDir, channels: {} });
      const { sent } = await r.flushDigest();
      assert.equal(sent, 0);
    });

    it('shouldFlushDigest respects interval', async () => {
      const r = new router.NotificationRouter({
        projectRoot: tmpDir,
        channels: {},
        digest_interval_minutes: 999 // very long interval
      });
      await r.route({ title: 'Info', body: 'A', severity: 'info' });
      assert.equal(r.shouldFlushDigest(), false); // not enough time elapsed
    });

    it('shouldFlushDigest returns true when interval elapsed', async () => {
      // Use a separate temp dir to avoid interference from previous tests
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-notify2-'));
      try {
        const r = new router.NotificationRouter({
          projectRoot: tmpDir2,
          channels: {},
          digest_interval_minutes: 1 // 1 minute
        });
        await r.route({ title: 'Info', body: 'A', severity: 'info' });

        // Manually backdate the queued_at to exceed the 1-minute interval
        const digestPath = r._digestPath();
        const queue = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
        queue[0].queued_at = new Date(Date.now() - 120000).toISOString(); // 2 min ago
        fs.writeFileSync(digestPath, JSON.stringify(queue));

        assert.equal(r.shouldFlushDigest(), true);
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // SINGLETON
  // =========================================================================

  describe('getRouter / resetRouter', () => {
    it('returns a router instance', () => {
      const r = router.getRouter(tmpDir);
      assert.ok(r instanceof router.NotificationRouter);
    });

    it('returns same instance on second call', () => {
      const r1 = router.getRouter(tmpDir);
      const r2 = router.getRouter(tmpDir);
      assert.strictEqual(r1, r2);
    });

    it('resetRouter clears singleton', () => {
      const r1 = router.getRouter(tmpDir);
      router.resetRouter();
      const r2 = router.getRouter(tmpDir);
      assert.notStrictEqual(r1, r2);
    });
  });

  // =========================================================================
  // _buildDigest
  // =========================================================================

  describe('_buildDigest', () => {
    it('builds a digest notification from queue', () => {
      const queue = [
        { title: 'Event 1', severity: 'info', queued_at: new Date().toISOString() },
        { title: 'Event 2', severity: 'warning', queued_at: new Date().toISOString() },
        { title: 'Event 3', severity: 'info', queued_at: new Date().toISOString() }
      ];
      const digest = router._buildDigest(queue);
      assert.match(digest.title, /3 notifications/);
      assert.match(digest.body, /Event 1/);
      assert.match(digest.body, /Event 2/);
      assert.equal(digest.severity, 'info');
      assert.equal(digest.data.total, 3);
    });

    it('handles empty queue', () => {
      const digest = router._buildDigest([]);
      assert.match(digest.title, /0 notifications/);
    });
  });

  // =========================================================================
  // CONVENIENCE FUNCTION
  // =========================================================================

  describe('notify', () => {
    it('routes through singleton', async () => {
      router.resetRouter();
      // Will create router with defaults — system adapter
      const result = await router.notify({
        title: 'Test',
        body: 'Body',
        severity: 'info'
      });
      // Info is queued
      assert.equal(result.queued, true);
      router.resetRouter();
    });
  });
});
