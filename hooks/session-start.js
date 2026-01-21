#!/usr/bin/env node

/**
 * Pilot AGI Session Start Hook
 *
 * Runs when Claude Code session starts.
 * Checks for updates and injects project context.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Get installed version
function getInstalledVersion() {
  const locations = [
    path.join(process.env.HOME || '', '.claude', 'pilot-version'),
    path.join(process.cwd(), '.claude', 'pilot-version')
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return fs.readFileSync(loc, 'utf8').trim();
    }
  }
  return null;
}

// Check npm for latest version
function checkLatestVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: '/pilot-agi/latest',
      method: 'GET',
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          resolve(pkg.version);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });

    req.end();
  });
}

// Compare semantic versions
function isNewer(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }
  return false;
}

// Read project state if exists
function getProjectContext() {
  const statePath = path.join(process.cwd(), '.planning', 'STATE.md');

  if (fs.existsSync(statePath)) {
    const state = fs.readFileSync(statePath, 'utf8');
    // Extract current position
    const milestoneMatch = state.match(/Milestone:\s*(.+)/);
    const phaseMatch = state.match(/Phase:\s*(.+)/);
    const statusMatch = state.match(/Status:\s*(.+)/);

    if (milestoneMatch || phaseMatch) {
      return {
        milestone: milestoneMatch ? milestoneMatch[1].trim() : 'Unknown',
        phase: phaseMatch ? phaseMatch[1].trim() : 'Unknown',
        status: statusMatch ? statusMatch[1].trim() : 'Unknown'
      };
    }
  }
  return null;
}

async function main() {
  const output = {
    continue: true,
    systemMessage: ''
  };

  const messages = [];
  const installedVersion = getInstalledVersion();

  // Check for updates (silent fail)
  if (installedVersion) {
    try {
      const latestVersion = await checkLatestVersion();
      if (isNewer(latestVersion, installedVersion)) {
        messages.push(`Pilot AGI update available: v${latestVersion} (current: v${installedVersion}). Run /pilot:update to upgrade.`);
      }
    } catch (e) {
      // Silent fail - don't bother user with network issues
    }
  }

  // Inject project context
  const context = getProjectContext();
  if (context) {
    messages.push(`Pilot AGI project detected. Current: Milestone ${context.milestone}, Phase ${context.phase} (${context.status})`);
  }

  if (messages.length > 0) {
    output.systemMessage = messages.join('\n');
  }

  console.log(JSON.stringify(output));
}

main().catch(() => {
  // On any error, just continue without output
  console.log(JSON.stringify({ continue: true }));
});
