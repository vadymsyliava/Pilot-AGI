'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module helper
function freshModule(modPath) {
  const resolved = require.resolve(modPath);
  delete require.cache[resolved];
  return require(resolved);
}

describe('notification-channels', () => {
  let channels;

  beforeEach(() => {
    channels = freshModule('../.claude/pilot/hooks/lib/notification-channels');
  });

  // =========================================================================
  // ADAPTER REGISTRY
  // =========================================================================

  describe('createAdapters', () => {
    it('creates adapters from config', () => {
      const adapters = channels.createAdapters({
        slack: { webhook_url: 'https://hooks.slack.com/test', enabled: true },
        discord: { webhook_url: 'https://discord.com/api/webhooks/test', enabled: true }
      });
      assert.ok(adapters.has('slack'));
      assert.ok(adapters.has('discord'));
      assert.ok(adapters.has('system')); // always included
    });

    it('always includes system adapter', () => {
      const adapters = channels.createAdapters({});
      assert.ok(adapters.has('system'));
    });

    it('ignores unknown channel names', () => {
      const adapters = channels.createAdapters({
        unknown_channel: { enabled: true }
      });
      assert.ok(!adapters.has('unknown_channel'));
      assert.ok(adapters.has('system'));
    });
  });

  // =========================================================================
  // SLACK ADAPTER
  // =========================================================================

  describe('SlackAdapter', () => {
    it('returns disabled when not enabled', async () => {
      const adapter = new channels.SlackAdapter({ enabled: false });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'disabled');
    });

    it('requires webhook_url', async () => {
      const adapter = new channels.SlackAdapter({ enabled: true });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.match(result.error, /webhook_url/);
    });

    it('has correct name', () => {
      const adapter = new channels.SlackAdapter({});
      assert.equal(adapter.name, 'slack');
    });
  });

  // =========================================================================
  // DISCORD ADAPTER
  // =========================================================================

  describe('DiscordAdapter', () => {
    it('returns disabled when not enabled', async () => {
      const adapter = new channels.DiscordAdapter({ enabled: false });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'disabled');
    });

    it('requires webhook_url', async () => {
      const adapter = new channels.DiscordAdapter({ enabled: true });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.match(result.error, /webhook_url/);
    });

    it('has correct name', () => {
      const adapter = new channels.DiscordAdapter({});
      assert.equal(adapter.name, 'discord');
    });
  });

  // =========================================================================
  // EMAIL ADAPTER
  // =========================================================================

  describe('EmailAdapter', () => {
    it('returns disabled when not enabled', async () => {
      const adapter = new channels.EmailAdapter({ enabled: false });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'disabled');
    });

    it('requires to address', async () => {
      const adapter = new channels.EmailAdapter({ enabled: true });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.match(result.error, /to/);
    });

    it('has correct name', () => {
      const adapter = new channels.EmailAdapter({});
      assert.equal(adapter.name, 'email');
    });
  });

  // =========================================================================
  // SYSTEM ADAPTER
  // =========================================================================

  describe('SystemAdapter', () => {
    it('has correct name', () => {
      const adapter = new channels.SystemAdapter({});
      assert.equal(adapter.name, 'system');
    });

    it('returns disabled when not enabled', async () => {
      const adapter = new channels.SystemAdapter({ enabled: false });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.equal(result.error, 'disabled');
    });

    // Note: actual osascript send tested only on macOS
  });

  // =========================================================================
  // HELPER FUNCTIONS
  // =========================================================================

  describe('_severityEmoji', () => {
    it('returns emoji for each severity', () => {
      assert.ok(channels._severityEmoji('critical').length > 0);
      assert.ok(channels._severityEmoji('warning').length > 0);
      assert.ok(channels._severityEmoji('info').length > 0);
      assert.ok(channels._severityEmoji('unknown').length > 0);
    });
  });

  describe('_severityColor', () => {
    it('returns different colors for different severities', () => {
      assert.notEqual(channels._severityColor('critical'), channels._severityColor('info'));
      assert.notEqual(channels._severityColor('warning'), channels._severityColor('info'));
    });
  });

  // =========================================================================
  // BASE ADAPTER
  // =========================================================================

  describe('NotificationAdapter (base)', () => {
    it('throws on direct _send call', async () => {
      const adapter = new channels.NotificationAdapter({ enabled: true });
      const result = await adapter.send({ title: 'Test', body: 'Body', severity: 'info' });
      assert.equal(result.success, false);
      assert.match(result.error, /must be overridden/);
    });
  });
});
