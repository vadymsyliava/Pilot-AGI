#!/usr/bin/env node

/**
 * Token Publisher
 *
 * Publishes the full design token set to the shared memory layer
 * on the 'design-tokens' channel. Other agents (frontend, review)
 * can then consume the latest tokens via memory.read('design-tokens').
 *
 * Usage: node design/scripts/publish-tokens.js
 */

const path = require('path');
const { loadAllTokens, indexTokenPaths } = require('./validate-tokens');

// ---------------------------------------------------------------------------
// Build DTCG-structured data for the memory channel
// ---------------------------------------------------------------------------

function buildPublishPayload() {
  const { merged } = loadAllTokens();
  const tokenIndex = indexTokenPaths(merged);

  // Organize tokens into the schema-required categories
  const payload = {
    colors: {},
    spacing: {},
    typography: {},
    shadows: {},
    radii: {},
    breakpoints: {},
    zIndex: {},
    animation: {}
  };

  for (const [tokenPath, token] of Object.entries(tokenIndex)) {
    const entry = {
      $value: token.$value,
      $type: token.$type
    };
    if (token.$description) entry.$description = token.$description;

    if (tokenPath.startsWith('color.')) {
      setNested(payload.colors, tokenPath.replace('color.', ''), entry);
    } else if (tokenPath.startsWith('spacing.')) {
      payload.spacing[tokenPath.replace('spacing.', '')] = entry;
    } else if (tokenPath.startsWith('font.')) {
      setNested(payload.typography, tokenPath.replace('font.', ''), entry);
    } else if (tokenPath.startsWith('shadow.')) {
      payload.shadows[tokenPath.replace('shadow.', '')] = entry;
    } else if (tokenPath.startsWith('radius.')) {
      payload.radii[tokenPath.replace('radius.', '')] = entry;
    } else if (tokenPath.startsWith('breakpoint.')) {
      payload.breakpoints[tokenPath.replace('breakpoint.', '')] = entry;
    } else if (tokenPath.startsWith('zIndex.')) {
      payload.zIndex[tokenPath.replace('zIndex.', '')] = entry;
    } else if (tokenPath.startsWith('duration.') || tokenPath.startsWith('easing.')) {
      setNested(payload.animation, tokenPath, entry);
    }
  }

  return { payload, tokenCount: Object.keys(tokenIndex).length };
}

function setNested(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Publish to shared memory
// ---------------------------------------------------------------------------

function publish() {
  const memory = require('../../.claude/pilot/hooks/lib/memory');
  const { payload, tokenCount } = buildPublishPayload();

  const envelope = memory.publish('design-tokens', payload, {
    agent: 'design',
    summary: `DTCG tokens published: ${tokenCount} tokens across 8 categories`
  });

  return { envelope, tokenCount };
}

// CLI entry point
if (require.main === module) {
  const { envelope, tokenCount } = publish();
  console.log(`Published to: design-tokens (v${envelope.version})`);
  console.log(`Token count: ${tokenCount}`);
  console.log(`Categories: colors, spacing, typography, shadows, radii, breakpoints, zIndex, animation`);
}

module.exports = { publish, buildPublishPayload };
