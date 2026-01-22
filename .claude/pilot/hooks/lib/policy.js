/**
 * Policy Loader
 *
 * Loads and validates the governance policy from policy.yaml.
 * Used by hooks to enforce rules.
 */

const fs = require('fs');
const path = require('path');

const POLICY_FILENAME = 'policy.yaml';

/**
 * Simple YAML parser for policy files
 * Handles the subset of YAML we use: scalars, arrays, objects
 */
function parseYaml(content) {
  const result = {};
  const lines = content.split('\n');
  const stack = [{ obj: result, indent: -1 }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Calculate indent level
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack until we find parent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].obj;

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      if (!Array.isArray(current)) {
        // Convert parent key to array
        const parentKey = stack[stack.length - 1].key;
        if (parentKey && stack.length > 1) {
          stack[stack.length - 2].obj[parentKey] = [];
          stack[stack.length - 1].obj = stack[stack.length - 2].obj[parentKey];
        }
      }
      if (Array.isArray(stack[stack.length - 1].obj)) {
        stack[stack.length - 1].obj.push(parseValue(value));
      }
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === '' || rawValue === '|') {
      // Nested object or multiline - look ahead
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.search(/\S/) > indent) {
        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.startsWith('- ')) {
          // It's an array
          current[key] = [];
          stack.push({ obj: current[key], indent: indent, key: key });
        } else {
          // It's an object
          current[key] = {};
          stack.push({ obj: current[key], indent: indent, key: key });
        }
      } else {
        current[key] = null;
      }
    } else {
      current[key] = parseValue(rawValue);
    }
  }

  return result;
}

/**
 * Parse a YAML value
 */
function parseValue(str) {
  if (!str) return null;

  // Remove inline comments
  const commentIdx = str.indexOf(' #');
  if (commentIdx > 0) {
    str = str.slice(0, commentIdx).trim();
  }

  // Boolean
  if (str === 'true') return true;
  if (str === 'false') return false;

  // Null
  if (str === 'null' || str === '~') return null;

  // Quoted string
  if ((str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }

  // Number
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str);

  return str;
}

/**
 * Find policy file in standard locations
 */
function findPolicyPath() {
  const locations = [
    path.join(process.cwd(), '.claude', 'pilot', POLICY_FILENAME),
    path.join(process.env.HOME || '', '.claude', 'pilot', POLICY_FILENAME)
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  return null;
}

/**
 * Load policy from file
 * @returns {Object} Policy object or default policy if not found
 */
function loadPolicy() {
  const policyPath = findPolicyPath();

  if (!policyPath) {
    return getDefaultPolicy();
  }

  try {
    const content = fs.readFileSync(policyPath, 'utf8');
    const policy = parseYaml(content);
    return mergeWithDefaults(policy);
  } catch (e) {
    console.error(`Warning: Failed to parse policy.yaml: ${e.message}`);
    return getDefaultPolicy();
  }
}

/**
 * Default policy when no file exists
 */
function getDefaultPolicy() {
  return {
    version: '1.0',
    enforcement: {
      require_active_task: true,
      require_plan_approval: true,
      plan_approval_threshold: 'medium',
      protected_branches: ['main', 'master'],
      detect_new_scope: true,
      new_scope_keywords: ['add feature', 'implement', 'create new', 'build', 'fix bug']
    },
    execution: {
      require_verification: true,
      require_commit_per_step: true,
      require_run_log_update: true,
      require_bd_update: true
    },
    areas: {},
    session: {
      heartbeat_interval_sec: 60,
      lock_timeout_min: 30,
      max_concurrent_sessions: 6
    },
    exceptions: {
      no_task_required: ['runs/*.md'],
      no_plan_required: ['runs/*.md', '*.md'],
      never_edit: ['.env', '.env.*', '*.pem', '*.key']
    }
  };
}

/**
 * Merge loaded policy with defaults
 */
function mergeWithDefaults(policy) {
  const defaults = getDefaultPolicy();

  return {
    version: policy.version || defaults.version,
    enforcement: { ...defaults.enforcement, ...policy.enforcement },
    execution: { ...defaults.execution, ...policy.execution },
    areas: policy.areas || defaults.areas,
    session: { ...defaults.session, ...policy.session },
    exceptions: { ...defaults.exceptions, ...policy.exceptions }
  };
}

/**
 * Check if a file path matches any pattern in a list
 * Supports simple glob patterns: *, **
 */
function matchesPattern(filePath, patterns) {
  if (!patterns || !Array.isArray(patterns)) return false;

  for (const pattern of patterns) {
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');

    if (new RegExp(`^${regex}$`).test(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Get the area for a file path
 */
function getAreaForFile(filePath, policy) {
  const areas = policy.areas || {};

  for (const [areaName, areaConfig] of Object.entries(areas)) {
    if (matchesPattern(filePath, areaConfig.paths)) {
      return { name: areaName, ...areaConfig };
    }
  }

  return null;
}

/**
 * Check if file is in exceptions list
 */
function isException(filePath, exceptionType, policy) {
  const exceptions = policy.exceptions || {};
  const patterns = exceptions[exceptionType];
  return matchesPattern(filePath, patterns);
}

module.exports = {
  loadPolicy,
  getDefaultPolicy,
  getAreaForFile,
  isException,
  matchesPattern,
  parseYaml
};
