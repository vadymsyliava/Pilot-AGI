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
