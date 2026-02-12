'use strict';

/**
 * Notification Channel Adapters — Phase 5.9
 *
 * Adapter pattern with common interface: send(notification).
 * Each adapter handles formatting and delivery for its channel.
 *
 * Channels:
 *   - Slack   (webhook POST with Block Kit)
 *   - Discord (webhook POST with embeds)
 *   - Email   (nodemailer SMTP)
 *   - System  (macOS notification via osascript)
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execFile } = require('child_process');

// ============================================================================
// BASE ADAPTER
// ============================================================================

class NotificationAdapter {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.enabled !== false;
  }

  get name() { return 'base'; }

  /**
   * Send a notification.
   * @param {object} notification
   * @param {string} notification.title - Short title
   * @param {string} notification.body  - Message body (markdown)
   * @param {string} notification.severity - 'critical' | 'warning' | 'info'
   * @param {string} [notification.event] - Event type (e.g. 'escalation.human')
   * @param {object} [notification.data] - Additional structured data
   * @returns {Promise<{success: boolean, channel: string, error?: string}>}
   */
  async send(notification) {
    if (!this.enabled) {
      return { success: false, channel: this.name, error: 'disabled' };
    }
    try {
      await this._send(notification);
      return { success: true, channel: this.name };
    } catch (err) {
      return { success: false, channel: this.name, error: err.message };
    }
  }

  async _send(_notification) {
    throw new Error('NotificationAdapter._send() must be overridden');
  }
}

// ============================================================================
// SLACK ADAPTER — Webhook POST with Block Kit
// ============================================================================

class SlackAdapter extends NotificationAdapter {
  get name() { return 'slack'; }

  async _send(notification) {
    const webhookUrl = this.config.webhook_url;
    if (!webhookUrl) throw new Error('Slack webhook_url not configured');

    const emoji = _severityEmoji(notification.severity);
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} ${notification.title}`, emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: notification.body || '' }
      }
    ];

    if (notification.data) {
      const fields = Object.entries(notification.data)
        .filter(([, v]) => v != null)
        .slice(0, 10)
        .map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*: ${v}` }));
      if (fields.length > 0) {
        blocks.push({ type: 'section', fields });
      }
    }

    const payload = JSON.stringify({
      text: `${emoji} ${notification.title}: ${notification.body || ''}`,
      blocks
    });

    await _httpPost(webhookUrl, payload, { 'Content-Type': 'application/json' });
  }
}

// ============================================================================
// DISCORD ADAPTER — Webhook POST with embeds
// ============================================================================

class DiscordAdapter extends NotificationAdapter {
  get name() { return 'discord'; }

  async _send(notification) {
    const webhookUrl = this.config.webhook_url;
    if (!webhookUrl) throw new Error('Discord webhook_url not configured');

    const color = _severityColor(notification.severity);
    const embed = {
      title: notification.title,
      description: notification.body || '',
      color,
      timestamp: new Date().toISOString()
    };

    if (notification.data) {
      embed.fields = Object.entries(notification.data)
        .filter(([, v]) => v != null)
        .slice(0, 10)
        .map(([k, v]) => ({ name: k, value: String(v), inline: true }));
    }

    const payload = JSON.stringify({
      content: notification.severity === 'critical'
        ? `@here ${_severityEmoji(notification.severity)} **${notification.title}**`
        : null,
      embeds: [embed]
    });

    await _httpPost(webhookUrl, payload, { 'Content-Type': 'application/json' });
  }
}

// ============================================================================
// EMAIL ADAPTER — nodemailer SMTP
// ============================================================================

class EmailAdapter extends NotificationAdapter {
  get name() { return 'email'; }

  async _send(notification) {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, from, to } = this.config;
    if (!to) throw new Error('Email "to" address not configured');

    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch {
      throw new Error('nodemailer not installed. Run: npm install nodemailer');
    }

    const transporter = nodemailer.createTransport({
      host: smtp_host || 'localhost',
      port: smtp_port || 587,
      secure: (smtp_port || 587) === 465,
      auth: smtp_user ? { user: smtp_user, pass: smtp_pass } : undefined
    });

    const emoji = _severityEmoji(notification.severity);
    const subject = `${emoji} [Pilot AGI] ${notification.title}`;
    let html = `<h2>${notification.title}</h2><p>${_escapeHtml(notification.body || '')}</p>`;

    if (notification.data) {
      html += '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">';
      for (const [k, v] of Object.entries(notification.data)) {
        if (v != null) {
          html += `<tr><td><b>${_escapeHtml(k)}</b></td><td>${_escapeHtml(String(v))}</td></tr>`;
        }
      }
      html += '</table>';
    }

    await transporter.sendMail({
      from: from || 'pilot-agi@localhost',
      to,
      subject,
      html,
      text: `${notification.title}\n\n${notification.body || ''}`
    });
  }
}

// ============================================================================
// SYSTEM ADAPTER — macOS notification via osascript
// ============================================================================

class SystemAdapter extends NotificationAdapter {
  get name() { return 'system'; }

  async _send(notification) {
    const title = (notification.title || '').replace(/"/g, '\\"');
    const body = (notification.body || '').substring(0, 200).replace(/"/g, '\\"');
    const script = `display notification "${body}" with title "Pilot AGI" subtitle "${title}" sound name "Glass"`;

    return new Promise((resolve, reject) => {
      execFile('osascript', ['-e', script], { timeout: 5000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

const ADAPTERS = {
  slack: SlackAdapter,
  discord: DiscordAdapter,
  email: EmailAdapter,
  system: SystemAdapter
};

/**
 * Create adapter instances from policy config.
 * @param {object} channelConfigs - { slack: {webhook_url, enabled}, discord: {...}, ... }
 * @returns {Map<string, NotificationAdapter>}
 */
function createAdapters(channelConfigs = {}) {
  const adapters = new Map();
  for (const [name, config] of Object.entries(channelConfigs)) {
    const AdapterClass = ADAPTERS[name];
    if (AdapterClass) {
      adapters.set(name, new AdapterClass(config));
    }
  }
  // Always include system adapter as fallback
  if (!adapters.has('system')) {
    adapters.set('system', new SystemAdapter({ enabled: true }));
  }
  return adapters;
}

// ============================================================================
// HELPERS
// ============================================================================

function _severityEmoji(severity) {
  switch (severity) {
    case 'critical': return '\u{1F6A8}'; // 🚨
    case 'warning':  return '\u{26A0}\u{FE0F}'; // ⚠️
    case 'info':     return '\u{2139}\u{FE0F}'; // ℹ️
    default:         return '\u{1F514}'; // 🔔
  }
}

function _severityColor(severity) {
  switch (severity) {
    case 'critical': return 0xFF0000;
    case 'warning':  return 0xFFA500;
    case 'info':     return 0x0099FF;
    default:         return 0x808080;
  }
}

function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _httpPost(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  NotificationAdapter,
  SlackAdapter,
  DiscordAdapter,
  EmailAdapter,
  SystemAdapter,
  ADAPTERS,
  createAdapters,
  _httpPost, // exported for testing
  _severityEmoji,
  _severityColor
};
