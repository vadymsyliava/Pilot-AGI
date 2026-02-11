/**
 * Shared Memory Layer
 *
 * Cross-agent knowledge sharing via file-based channels.
 * Each channel has a single publisher and multiple consumers.
 * Per-agent memory files store learned preferences and discoveries.
 *
 * Concurrency model:
 * - Channels: single publisher per channel (no write contention)
 * - Agent memory: per-agent ownership (no contention)
 * - Atomic writes via write-to-tmp-then-rename
 * - Event stream append for publication notifications
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = '.claude/pilot/memory';
const CHANNELS_DIR = '.claude/pilot/memory/channels';
const AGENTS_DIR = '.claude/pilot/memory/agents';
const SCHEMAS_DIR = '.claude/pilot/memory/schemas';
const INDEX_FILE = '.claude/pilot/memory/index.json';

// =============================================================================
// PATH HELPERS
// =============================================================================

function getMemoryDir() {
  return path.join(process.cwd(), MEMORY_DIR);
}

function getChannelsDir() {
  return path.join(process.cwd(), CHANNELS_DIR);
}

function getAgentsDir() {
  return path.join(process.cwd(), AGENTS_DIR);
}

function getSchemasDir() {
  return path.join(process.cwd(), SCHEMAS_DIR);
}

function getIndexPath() {
  return path.join(process.cwd(), INDEX_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// =============================================================================
// ATOMIC WRITE
// =============================================================================

/**
 * Write data atomically using write-to-tmp-then-rename.
 * rename() is atomic on POSIX (macOS APFS, Linux ext4).
 */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = filePath + '.tmp.' + process.pid;
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

// =============================================================================
// INDEX MANAGEMENT
// =============================================================================

/**
 * Load channel index
 */
function loadIndex() {
  const indexPath = getIndexPath();

  if (!fs.existsSync(indexPath)) {
    return { version: 1, channels: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return { version: 1, channels: {} };
  }
}

/**
 * List all registered channels
 */
function listChannels() {
  const index = loadIndex();
  return Object.keys(index.channels || {});
}

/**
 * Get channel metadata from index
 */
function getChannelInfo(channel) {
  const index = loadIndex();
  const entry = (index.channels || {})[channel];

  if (!entry) return null;

  // Augment with runtime info from channel file
  const channelPath = path.join(getChannelsDir(), `${channel}.json`);
  let version = 0;
  let lastUpdated = null;

  if (fs.existsSync(channelPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
      version = data.version || 0;
      lastUpdated = data.publishedAt || null;
    } catch (e) {
      // ignore
    }
  }

  return {
    channel,
    description: entry.description,
    publisher: entry.publisher,
    consumers: entry.consumers || [],
    schema: entry.schema || null,
    version,
    lastUpdated
  };
}

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

/**
 * Validate data against a channel's JSON schema.
 * Lightweight validation: checks required fields and types.
 * Returns { valid: boolean, errors: string[] }
 */
function validateAgainstSchema(channel, data) {
  const index = loadIndex();
  const entry = (index.channels || {})[channel];

  if (!entry || !entry.schema) {
    return { valid: true, errors: [] };
  }

  const schemaPath = path.join(getMemoryDir(), entry.schema);

  if (!fs.existsSync(schemaPath)) {
    return { valid: true, errors: [] };
  }

  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    return validateObject(data, schema, '');
  } catch (e) {
    return { valid: false, errors: [`Schema parse error: ${e.message}`] };
  }
}

/**
 * Lightweight JSON Schema validator (subset: type, required, properties)
 */
function validateObject(data, schema, prefix) {
  const errors = [];

  // Type check
  if (schema.type) {
    const actualType = Array.isArray(data) ? 'array' : typeof data;
    if (actualType !== schema.type) {
      errors.push(`${prefix || 'root'}: expected ${schema.type}, got ${actualType}`);
      return { valid: false, errors };
    }
  }

  // Required fields
  if (schema.required && schema.type === 'object') {
    for (const field of schema.required) {
      if (data[field] === undefined) {
        errors.push(`${prefix || 'root'}: missing required field '${field}'`);
      }
    }
  }

  // Recurse into properties
  if (schema.properties && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (data[key] !== undefined) {
        const result = validateObject(data[key], propSchema, `${prefix ? prefix + '.' : ''}${key}`);
        errors.push(...result.errors);
      }
    }
  }

  // Array items
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const result = validateObject(data[i], schema.items, `${prefix}[${i}]`);
      errors.push(...result.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// CHANNEL OPERATIONS (Pub/Sub)
// =============================================================================

/**
 * Publish data to a channel.
 * Atomically writes to channels/<channel>.json with version bump.
 * Emits memory_published event to sessions.jsonl.
 *
 * @param {string} channel - Channel name
 * @param {object} data - Data to publish
 * @param {object} meta - { agent, sessionId, summary }
 */
function publish(channel, data, meta = {}) {
  const channelPath = path.join(getChannelsDir(), `${channel}.json`);

  // Validate against schema if one exists
  const validation = validateAgainstSchema(channel, data);
  if (!validation.valid) {
    throw new Error(`Schema validation failed for channel '${channel}':\n${validation.errors.join('\n')}`);
  }

  // Read existing version
  let version = 0;
  if (fs.existsSync(channelPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
      version = existing.version || 0;
    } catch (e) {
      // Start fresh
    }
  }

  const envelope = {
    channel,
    version: version + 1,
    publishedBy: meta.agent || 'unknown',
    sessionId: meta.sessionId || null,
    publishedAt: new Date().toISOString(),
    summary: meta.summary || null,
    data
  };

  atomicWrite(channelPath, envelope);

  // Log event to sessions.jsonl
  try {
    const { logEvent } = require('./session');
    logEvent({
      type: 'memory_published',
      session_id: meta.sessionId || null,
      agent: meta.agent || 'unknown',
      channel,
      version: envelope.version
    });
  } catch (e) {
    // Best effort - don't fail publish on event logging error
  }

  return envelope;
}

/**
 * Read full channel data.
 * Returns the envelope object or null if channel doesn't exist.
 */
function read(channel) {
  const channelPath = path.join(getChannelsDir(), `${channel}.json`);

  if (!fs.existsSync(channelPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(channelPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Read only the summary of a channel (token-efficient).
 * Returns { channel, version, summary, publishedAt } or null.
 */
function readSummary(channel) {
  const envelope = read(channel);
  if (!envelope) return null;

  return {
    channel: envelope.channel,
    version: envelope.version,
    summary: envelope.summary,
    publishedAt: envelope.publishedAt,
    publishedBy: envelope.publishedBy
  };
}

// =============================================================================
// PER-AGENT MEMORY
// =============================================================================

/**
 * Set agent-specific memory (preferences, learned patterns).
 * Each agent owns its own memory directory.
 */
function setAgentMemory(agentType, key, value) {
  const agentDir = path.join(getAgentsDir(), agentType);
  ensureDir(agentDir);

  const filePath = path.join(agentDir, `${key}.json`);
  atomicWrite(filePath, {
    key,
    agentType,
    updatedAt: new Date().toISOString(),
    data: value
  });
}

/**
 * Get agent-specific memory.
 * Returns the data or null if not found.
 */
function getAgentMemory(agentType, key) {
  const filePath = path.join(getAgentsDir(), agentType, `${key}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return envelope.data;
  } catch (e) {
    return null;
  }
}

/**
 * Record a discovery (append-only).
 * Discoveries are things an agent learned during execution.
 */
function recordDiscovery(agentType, entry) {
  const agentDir = path.join(getAgentsDir(), agentType);
  ensureDir(agentDir);

  const filePath = path.join(agentDir, 'discoveries.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  }) + '\n';

  fs.appendFileSync(filePath, line);
}

/**
 * Get all discoveries for an agent.
 * Returns array of discovery entries.
 */
function getDiscoveries(agentType) {
  const filePath = path.join(getAgentsDir(), agentType, 'discoveries.jsonl');

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];

    return content.split('\n').map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// =============================================================================
// DECISION LOG (Phase 3.7)
// =============================================================================

/**
 * Record a decision made by an agent (append-only).
 * Decisions are choices about libraries, patterns, approaches, etc.
 *
 * @param {string} agentType - Agent role (e.g., 'frontend', 'backend')
 * @param {object} entry - { decision, reason, alternatives_considered, task_id }
 */
function recordDecision(agentType, entry) {
  const agentDir = path.join(getAgentsDir(), agentType);
  ensureDir(agentDir);

  const filePath = path.join(agentDir, 'decisions.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  }) + '\n';

  fs.appendFileSync(filePath, line);
}

/**
 * Get decisions for an agent, optionally filtered.
 *
 * @param {string} agentType - Agent role
 * @param {object} [opts] - { limit, task_id }
 * @returns {Array} Decision entries
 */
function getDecisions(agentType, opts = {}) {
  const filePath = path.join(getAgentsDir(), agentType, 'decisions.jsonl');

  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];

    let entries = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);

    if (opts.task_id) {
      entries = entries.filter(e => e.task_id === opts.task_id);
    }

    if (opts.limit) {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  } catch (e) {
    return [];
  }
}

// =============================================================================
// ERROR/ISSUE LOG (Phase 3.7)
// =============================================================================

/**
 * Record an error/issue encountered by an agent (append-only).
 *
 * @param {string} agentType - Agent role
 * @param {object} entry - { error_type, context, resolution, task_id }
 */
function recordError(agentType, entry) {
  const agentDir = path.join(getAgentsDir(), agentType);
  ensureDir(agentDir);

  const filePath = path.join(agentDir, 'errors.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  }) + '\n';

  fs.appendFileSync(filePath, line);
}

/**
 * Get errors for an agent, optionally filtered.
 *
 * @param {string} agentType - Agent role
 * @param {object} [opts] - { limit, error_type }
 * @returns {Array} Error entries
 */
function getErrors(agentType, opts = {}) {
  const filePath = path.join(getAgentsDir(), agentType, 'errors.jsonl');

  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];

    let entries = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);

    if (opts.error_type) {
      entries = entries.filter(e => e.error_type === opts.error_type);
    }

    if (opts.limit) {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  } catch (e) {
    return [];
  }
}

// =============================================================================
// CROSS-AGENT MEMORY QUERIES (Phase 3.7)
// =============================================================================

/**
 * Query another agent's memory by category.
 *
 * @param {string} agentType - Agent role to query
 * @param {string} category - 'preferences' | 'decisions' | 'discoveries' | 'errors'
 * @param {object} [opts] - { limit }
 * @returns {{ agent: string, category: string, data: any }}
 */
function queryAgentMemory(agentType, category, opts = {}) {
  const limit = opts.limit || 20;

  switch (category) {
    case 'preferences':
      return {
        agent: agentType,
        category,
        data: getAgentMemory(agentType, 'preferences')
      };
    case 'decisions':
      return {
        agent: agentType,
        category,
        data: getDecisions(agentType, { limit })
      };
    case 'discoveries':
      return {
        agent: agentType,
        category,
        data: getDiscoveries(agentType).slice(-limit)
      };
    case 'errors':
      return {
        agent: agentType,
        category,
        data: getErrors(agentType, { limit })
      };
    default:
      return { agent: agentType, category, data: null };
  }
}

/**
 * List all agent types that have memory data.
 * @returns {string[]} Agent type names
 */
function listAgentTypes() {
  const agentsDir = getAgentsDir();
  if (!fs.existsSync(agentsDir)) return [];

  try {
    return fs.readdirSync(agentsDir).filter(name => {
      const fullPath = path.join(agentsDir, name);
      return fs.statSync(fullPath).isDirectory() && !name.startsWith('S-');
    });
  } catch (e) {
    return [];
  }
}

// =============================================================================
// MEMORY PRUNING (Phase 3.7)
// =============================================================================

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Prune old entries from an agent's append-only JSONL files.
 * Removes entries older than TTL. Preferences are never pruned.
 *
 * @param {string} agentType - Agent role
 * @param {object} [opts] - { ttl_ms, categories }
 * @returns {{ pruned: object }} Counts of pruned entries per file
 */
function pruneAgentMemory(agentType, opts = {}) {
  const ttl = opts.ttl_ms || DEFAULT_TTL_MS;
  const categories = opts.categories || ['discoveries', 'errors'];
  const cutoff = new Date(Date.now() - ttl).toISOString();
  const pruned = {};

  for (const cat of categories) {
    const filePath = path.join(getAgentsDir(), agentType, `${cat}.jsonl`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) continue;

      const lines = content.split('\n');
      const kept = [];
      let removed = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.ts && entry.ts < cutoff) {
            removed++;
          } else {
            kept.push(line);
          }
        } catch (e) {
          kept.push(line); // Keep unparseable lines
        }
      }

      if (removed > 0) {
        atomicWrite(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
        pruned[cat] = removed;
      }
    } catch (e) {
      // Skip files that can't be read
    }
  }

  return { pruned };
}

/**
 * Get memory stats for an agent.
 *
 * @param {string} agentType - Agent role
 * @returns {{ files: object, total_bytes: number, total_entries: number }}
 */
function getMemoryStats(agentType) {
  const agentDir = path.join(getAgentsDir(), agentType);
  if (!fs.existsSync(agentDir)) {
    return { files: {}, total_bytes: 0, total_entries: 0 };
  }

  const files = {};
  let totalBytes = 0;
  let totalEntries = 0;

  try {
    for (const file of fs.readdirSync(agentDir)) {
      const filePath = path.join(agentDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const size = stat.size;
      let entries = 0;

      if (file.endsWith('.jsonl')) {
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          entries = content ? content.split('\n').length : 0;
        } catch (e) {
          // skip
        }
      } else if (file.endsWith('.json')) {
        entries = 1;
      }

      files[file] = { size, entries };
      totalBytes += size;
      totalEntries += entries;
    }
  } catch (e) {
    // skip
  }

  return { files, total_bytes: totalBytes, total_entries: totalEntries };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Channel operations
  publish,
  read,
  readSummary,
  listChannels,
  getChannelInfo,
  // Schema validation
  validateAgainstSchema,
  // Agent memory
  setAgentMemory,
  getAgentMemory,
  recordDiscovery,
  getDiscoveries,
  // Decision log (Phase 3.7)
  recordDecision,
  getDecisions,
  // Error log (Phase 3.7)
  recordError,
  getErrors,
  // Cross-agent queries (Phase 3.7)
  queryAgentMemory,
  listAgentTypes,
  // Memory pruning (Phase 3.7)
  pruneAgentMemory,
  getMemoryStats,
  DEFAULT_TTL_MS,
  // Index
  loadIndex,
  // Utilities
  atomicWrite,
  // Constants (for testing)
  MEMORY_DIR,
  CHANNELS_DIR,
  AGENTS_DIR,
  SCHEMAS_DIR
};
