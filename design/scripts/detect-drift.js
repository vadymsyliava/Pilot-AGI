#!/usr/bin/env node

/**
 * Design Drift Detection
 *
 * Detects design system drift by analyzing git changes for:
 * 1. New hardcoded values introduced in commits
 * 2. Token file changes without republishing to shared memory
 * 3. CSS/style modifications that bypass token variables
 *
 * Integrates with the PM orchestrator's drift detection model.
 *
 * Usage: node design/scripts/detect-drift.js [--since <ref>] [--json]
 *   --since <ref>   Git ref to compare against (default: HEAD~1)
 *   --json          Output as JSON
 *
 * Exit code: 0 = no drift, 1 = drift detected
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Reuse audit patterns for hardcoded value detection
const { VIOLATION_PATTERNS } = require('./audit-tokens');

// ---------------------------------------------------------------------------
// Git diff analysis (uses execFileSync to avoid shell injection)
// ---------------------------------------------------------------------------

function getChangedFiles(sinceRef) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', sinceRef], {
      encoding: 'utf8',
      timeout: 10000
    }).trim();
    return output ? output.split('\n') : [];
  } catch (e) {
    return [];
  }
}

function getDiffLines(sinceRef, file) {
  try {
    const output = execFileSync('git', ['diff', '-U0', sinceRef, '--', file], {
      encoding: 'utf8',
      timeout: 10000
    });
    // Extract only added lines (start with +, not +++)
    const lines = output.split('\n');
    const added = [];
    let currentLine = 0;

    for (const line of lines) {
      // Track line numbers from @@ headers
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push({
          content: line.slice(1),
          lineNum: currentLine
        });
        currentLine++;
      } else if (!line.startsWith('-')) {
        currentLine++;
      }
    }

    return added;
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Drift checks
// ---------------------------------------------------------------------------

/**
 * Check 1: New hardcoded values in added lines
 */
function checkHardcodedValues(sinceRef, changedFiles) {
  const violations = [];
  const uiExtensions = new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss']);
  const skipPaths = ['design/tokens', 'design/scripts', 'design/generated', 'tests/', '__tests__/', '.test.', '.spec.'];

  for (const file of changedFiles) {
    const ext = path.extname(file);
    if (!uiExtensions.has(ext)) continue;
    if (skipPaths.some(p => file.includes(p))) continue;

    const addedLines = getDiffLines(sinceRef, file);

    for (const { content, lineNum } of addedLines) {
      if (content.trim().startsWith('//') || content.trim().startsWith('*')) continue;

      for (const pattern of VIOLATION_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(content)) !== null) {
          violations.push({
            type: 'hardcoded_value',
            file,
            line: lineNum,
            match: match[0],
            rule: pattern.id,
            severity: pattern.severity,
            description: `New ${pattern.description.toLowerCase()} introduced`
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Check 2: Token files changed but not republished
 */
function checkTokenRepublish(changedFiles) {
  const tokenFiles = changedFiles.filter(f => f.startsWith('design/tokens/') && f.endsWith('.json'));

  if (tokenFiles.length === 0) return [];

  // Check if shared memory channel is stale
  const channelPath = path.join(process.cwd(), '.claude/pilot/memory/channels/design-tokens.json');
  if (!fs.existsSync(channelPath)) {
    return [{
      type: 'stale_publish',
      severity: 'error',
      description: 'Token files modified but design-tokens channel does not exist',
      files: tokenFiles
    }];
  }

  try {
    const channel = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
    const publishedAt = new Date(channel.publishedAt);

    // Check if any token file is newer than the published channel
    for (const tokenFile of tokenFiles) {
      const filePath = path.join(process.cwd(), tokenFile);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.mtime > publishedAt) {
          return [{
            type: 'stale_publish',
            severity: 'error',
            description: `Token files modified after last publish (v${channel.version})`,
            files: tokenFiles,
            lastPublished: channel.publishedAt
          }];
        }
      }
    }
  } catch (e) {
    return [{
      type: 'stale_publish',
      severity: 'warning',
      description: 'Could not verify token publish status',
      files: tokenFiles
    }];
  }

  return [];
}

/**
 * Check 3: Generated files out of sync with tokens
 */
function checkGeneratedSync(changedFiles) {
  const tokenFiles = changedFiles.filter(f => f.startsWith('design/tokens/') && f.endsWith('.json'));
  if (tokenFiles.length === 0) return [];

  const generatedFiles = [
    'design/generated/tokens.css',
    'design/generated/tailwind-tokens.js'
  ];

  const staleGenerated = [];
  for (const genFile of generatedFiles) {
    if (!changedFiles.includes(genFile)) {
      const fullPath = path.join(process.cwd(), genFile);
      if (fs.existsSync(fullPath)) {
        staleGenerated.push(genFile);
      }
    }
  }

  if (staleGenerated.length > 0) {
    return [{
      type: 'stale_generated',
      severity: 'warning',
      description: 'Token files changed but generated outputs not regenerated',
      tokenFiles,
      staleFiles: staleGenerated
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatReport(result) {
  if (!result.drifted) {
    return 'Design drift check: CLEAN\nNo drift detected.';
  }

  const lines = [];
  lines.push(`Design drift check: ${result.totalIssues} issue(s) detected\n`);

  if (result.hardcodedValues.length > 0) {
    lines.push(`Hardcoded values (${result.hardcodedValues.length}):`);
    for (const v of result.hardcodedValues) {
      const icon = v.severity === 'error' ? 'x' : '!';
      lines.push(`  [${icon}] ${v.file}:${v.line} ${v.description}: ${v.match}`);
    }
    lines.push('');
  }

  if (result.stalePublish.length > 0) {
    lines.push('Stale publish:');
    for (const v of result.stalePublish) {
      lines.push(`  [x] ${v.description}`);
      lines.push(`      Files: ${v.files.join(', ')}`);
    }
    lines.push('');
  }

  if (result.staleGenerated.length > 0) {
    lines.push('Stale generated outputs:');
    for (const v of result.staleGenerated) {
      lines.push(`  [!] ${v.description}`);
      lines.push(`      Run: node design/scripts/generate-css.js && node design/scripts/generate-tailwind.js`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function detectDrift(sinceRef) {
  const ref = sinceRef || 'HEAD~1';
  const changedFiles = getChangedFiles(ref);

  if (changedFiles.length === 0) {
    return {
      drifted: false,
      sinceRef: ref,
      changedFiles: 0,
      totalIssues: 0,
      hardcodedValues: [],
      stalePublish: [],
      staleGenerated: []
    };
  }

  const hardcodedValues = checkHardcodedValues(ref, changedFiles);
  const stalePublish = checkTokenRepublish(changedFiles);
  const staleGenerated = checkGeneratedSync(changedFiles);

  const totalIssues = hardcodedValues.length + stalePublish.length + staleGenerated.length;

  return {
    drifted: totalIssues > 0,
    sinceRef: ref,
    changedFiles: changedFiles.length,
    totalIssues,
    hardcodedValues,
    stalePublish,
    staleGenerated
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const sinceIdx = args.indexOf('--since');
  const sinceRef = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  const result = detectDrift(sinceRef);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
    console.log(`Analyzed ${result.changedFiles} changed files (since ${result.sinceRef})`);
  }

  process.exit(result.drifted ? 1 : 0);
}

module.exports = { detectDrift, checkHardcodedValues, checkTokenRepublish, checkGeneratedSync };
