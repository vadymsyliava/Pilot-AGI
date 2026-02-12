#!/usr/bin/env node

/**
 * Tailwind Config Generator
 *
 * Converts design tokens to a Tailwind CSS theme extension.
 * All values reference CSS custom properties (from generate-css.js)
 * so Tailwind classes stay in sync with tokens.
 *
 * Usage: node design/scripts/generate-tailwind.js
 * Output: design/generated/tailwind-tokens.js
 */

const fs = require('fs');
const path = require('path');
const { loadAllTokens, indexTokenPaths } = require('./validate-tokens');

const OUTPUT_PATH = path.join(__dirname, '..', 'generated', 'tailwind-tokens.js');

// ---------------------------------------------------------------------------
// Build CSS var references for Tailwind theme values
// ---------------------------------------------------------------------------

function varRef(tokenPath) {
  const varName = '--' + tokenPath.replace(/\./g, '-').replace(/\$/g, '').toLowerCase();
  return `var(${varName})`;
}

function hslVar(tokenPath) {
  const varName = '--' + tokenPath.replace(/\./g, '-').replace(/\$/g, '').toLowerCase();
  return `hsl(var(${varName}))`;
}

// ---------------------------------------------------------------------------
// Extract token groups by category
// ---------------------------------------------------------------------------

function extractGroup(tokenIndex, prefix) {
  const group = {};
  for (const tokenPath of Object.keys(tokenIndex)) {
    if (tokenPath.startsWith(prefix)) {
      const key = tokenPath.slice(prefix.length);
      if (key && !key.includes('.')) {
        group[key] = tokenPath;
      }
    }
  }
  return group;
}

function extractNestedGroup(tokenIndex, prefix) {
  const group = {};
  for (const tokenPath of Object.keys(tokenIndex)) {
    if (tokenPath.startsWith(prefix)) {
      const rest = tokenPath.slice(prefix.length);
      const parts = rest.split('.');
      if (parts.length === 1) {
        group[parts[0]] = tokenPath;
      } else if (parts.length === 2) {
        if (!group[parts[0]]) group[parts[0]] = {};
        group[parts[0]][parts[1]] = tokenPath;
      }
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// Generate the Tailwind theme config object
// ---------------------------------------------------------------------------

function generate() {
  const { merged } = loadAllTokens();
  const tokenIndex = indexTokenPaths(merged);

  const theme = { extend: {} };

  // ── Colors (semantic, mapped to HSL CSS vars) ──
  const colors = {};

  // Semantic color groups
  const colorGroups = extractNestedGroup(tokenIndex, 'color.semantic.');
  for (const [groupName, tokens] of Object.entries(colorGroups)) {
    if (typeof tokens === 'string') {
      colors[groupName] = hslVar(tokens);
    } else {
      colors[groupName] = {};
      for (const [shade, tokenPath] of Object.entries(tokens)) {
        colors[groupName][shade] = hslVar(tokenPath);
      }
    }
  }

  // Primitive color scales (for direct use: colors.blue.500 etc.)
  const primitiveColors = extractNestedGroup(tokenIndex, 'color.primitive.');
  for (const [colorName, tokens] of Object.entries(primitiveColors)) {
    if (typeof tokens === 'string') {
      colors[colorName] = hslVar(tokens);
    } else {
      colors[colorName] = {};
      for (const [shade, tokenPath] of Object.entries(tokens)) {
        colors[colorName][shade] = hslVar(tokenPath);
      }
    }
  }

  // shadcn/ui shorthand aliases
  colors.background = 'hsl(var(--background))';
  colors.foreground = 'hsl(var(--foreground))';
  colors.primary = { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' };
  colors.secondary = { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' };
  colors.muted = { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' };
  colors.accent = { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' };
  colors.destructive = { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' };
  colors.border = 'hsl(var(--border))';
  colors.input = 'hsl(var(--input))';
  colors.ring = 'hsl(var(--ring))';

  theme.extend.colors = colors;

  // ── Spacing ──
  const spacing = {};
  const spacingTokens = extractGroup(tokenIndex, 'spacing.');
  for (const [key, tokenPath] of Object.entries(spacingTokens)) {
    spacing[key] = varRef(tokenPath);
  }
  theme.extend.spacing = spacing;

  // ── Border Radius ──
  const borderRadius = {};
  const radiusTokens = extractGroup(tokenIndex, 'radius.');
  for (const [key, tokenPath] of Object.entries(radiusTokens)) {
    borderRadius[key] = varRef(tokenPath);
  }
  // shadcn/ui uses --radius for default
  borderRadius.DEFAULT = 'var(--radius)';
  theme.extend.borderRadius = borderRadius;

  // ── Box Shadow ──
  const boxShadow = {};
  const shadowTokens = extractGroup(tokenIndex, 'shadow.');
  for (const [key, tokenPath] of Object.entries(shadowTokens)) {
    boxShadow[key] = varRef(tokenPath);
  }
  theme.extend.boxShadow = boxShadow;

  // ── Font Family ──
  const fontFamily = {};
  const fontFamilyTokens = extractGroup(tokenIndex, 'font.family.');
  for (const [key, tokenPath] of Object.entries(fontFamilyTokens)) {
    fontFamily[key] = varRef(tokenPath);
  }
  theme.extend.fontFamily = fontFamily;

  // ── Font Size ──
  const fontSize = {};
  const fontSizeTokens = extractGroup(tokenIndex, 'font.size.');
  for (const [key, tokenPath] of Object.entries(fontSizeTokens)) {
    fontSize[key] = varRef(tokenPath);
  }
  theme.extend.fontSize = fontSize;

  // ── Font Weight ──
  const fontWeight = {};
  const fontWeightTokens = extractGroup(tokenIndex, 'font.weight.');
  for (const [key, tokenPath] of Object.entries(fontWeightTokens)) {
    fontWeight[key] = varRef(tokenPath);
  }
  theme.extend.fontWeight = fontWeight;

  // ── Line Height ──
  const lineHeight = {};
  const lineHeightTokens = extractGroup(tokenIndex, 'font.lineHeight.');
  for (const [key, tokenPath] of Object.entries(lineHeightTokens)) {
    lineHeight[key] = varRef(tokenPath);
  }
  theme.extend.lineHeight = lineHeight;

  // ── Letter Spacing ──
  const letterSpacing = {};
  const letterSpacingTokens = extractGroup(tokenIndex, 'font.letterSpacing.');
  for (const [key, tokenPath] of Object.entries(letterSpacingTokens)) {
    letterSpacing[key] = varRef(tokenPath);
  }
  theme.extend.letterSpacing = letterSpacing;

  // ── Breakpoints (screens) ──
  const screens = {};
  const breakpointTokens = extractGroup(tokenIndex, 'breakpoint.');
  for (const [key, tokenPath] of Object.entries(breakpointTokens)) {
    // Tailwind screens need raw values, not CSS vars (used at build time for media queries)
    screens[key] = tokenIndex[tokenPath].$value;
  }
  theme.extend.screens = screens;

  // ── Z-Index ──
  const zIndex = {};
  const zIndexTokens = extractGroup(tokenIndex, 'zIndex.');
  for (const [key, tokenPath] of Object.entries(zIndexTokens)) {
    zIndex[key] = varRef(tokenPath);
  }
  theme.extend.zIndex = zIndex;

  // ── Transition Duration ──
  const transitionDuration = {};
  const durationTokens = extractGroup(tokenIndex, 'duration.');
  for (const [key, tokenPath] of Object.entries(durationTokens)) {
    transitionDuration[key] = varRef(tokenPath);
  }
  theme.extend.transitionDuration = transitionDuration;

  // ── Transition Timing Function (easing) ──
  const transitionTimingFunction = {};
  const easingTokens = extractGroup(tokenIndex, 'easing.');
  for (const [key, tokenPath] of Object.entries(easingTokens)) {
    transitionTimingFunction[key] = varRef(tokenPath);
  }
  theme.extend.transitionTimingFunction = transitionTimingFunction;

  // ── Write output ──
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const output = `// Generated by design/scripts/generate-tailwind.js — DO NOT EDIT
// Source: design/tokens/*.json (W3C DTCG format)
// All values reference CSS custom properties from tokens.css

/** @type {import('tailwindcss').Config['theme']} */
module.exports = ${JSON.stringify(theme, null, 2)};
`;

  fs.writeFileSync(OUTPUT_PATH, output);

  // Count keys for reporting
  let keyCount = 0;
  for (const section of Object.values(theme.extend)) {
    if (typeof section === 'object') {
      keyCount += countKeys(section);
    }
  }

  return { outputPath: OUTPUT_PATH, keyCount, theme };
}

function countKeys(obj) {
  let count = 0;
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) {
      count += countKeys(val);
    } else {
      count++;
    }
  }
  return count;
}

// CLI entry point
if (require.main === module) {
  const result = generate();
  console.log(`Generated: ${result.outputPath}`);
  console.log(`Theme keys: ${result.keyCount}`);
}

module.exports = { generate };
