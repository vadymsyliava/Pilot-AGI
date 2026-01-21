#!/usr/bin/env node

/**
 * Pilot AGI Session Start Hook
 *
 * Runs when Claude Code session starts.
 * - Checks for Pilot AGI updates
 * - Gets beads context for current task
 * - Loads session capsule for crash recovery
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

function getInstalledVersion() {
  const locations = [
    path.join(process.env.HOME || '', '.claude', 'pilot', 'VERSION'),
    path.join(process.cwd(), '.claude', 'pilot', 'VERSION')
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return fs.readFileSync(loc, 'utf8').trim();
    }
  }
  return null;
}

function checkLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'registry.npmjs.org',
      path: '/pilot-agi/latest',
      method: 'GET',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).version);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function isNewer(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

function getBeadsContext() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) return null;

  try {
    const result = execSync('bd issues --status in_progress --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8', timeout: 5000
    });
    const tasks = JSON.parse(result);
    if (tasks.length > 0) {
      return { currentTask: { id: tasks[0].id, title: tasks[0].title } };
    }

    const ready = JSON.parse(execSync('bd ready --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8', timeout: 5000
    }));
    return { readyCount: ready.length };
  } catch (e) {
    return null;
  }
}

function getSessionContext() {
  const runsDir = path.join(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) return null;

  try {
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (files.length === 0) return null;

    const content = fs.readFileSync(path.join(runsDir, files[0]), 'utf8');
    const match = content.match(/Next action:\s*(.+)/);
    return match ? { file: files[0], nextAction: match[1].trim() } : { file: files[0] };
  } catch (e) {
    return null;
  }
}

async function main() {
  const output = { continue: true, systemMessage: '' };
  const messages = [];
  const version = getInstalledVersion();

  if (version) {
    try {
      const latest = await checkLatestVersion();
      if (isNewer(latest, version)) {
        messages.push(`Pilot AGI update: v${latest} available. Run /pilot-update`);
      }
    } catch (e) {}
  }

  const bd = getBeadsContext();
  if (bd) {
    if (bd.currentTask) {
      messages.push(`Active: [${bd.currentTask.id}] ${bd.currentTask.title}`);
    } else if (bd.readyCount > 0) {
      messages.push(`${bd.readyCount} tasks ready. Run /pilot-next`);
    }
  }

  const session = getSessionContext();
  if (session && session.nextAction) {
    messages.push(`Resume: ${session.nextAction}`);
  }

  if (messages.length > 0) {
    output.systemMessage = messages.join(' | ');
  }

  console.log(JSON.stringify(output));
}

main().catch(() => console.log(JSON.stringify({ continue: true })));
