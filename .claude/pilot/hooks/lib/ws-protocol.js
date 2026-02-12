/**
 * WebSocket Protocol — shared message types and validation for Agent-Connect
 *
 * Used by both pm-hub.js (server) and agent-connector.js (client).
 *
 * Agent → PM message types:
 *   register, heartbeat, task_complete, ask_pm, checkpoint, request
 *
 * PM → Agent message types:
 *   welcome, task_assign, answer, plan_approval, command, shutdown,
 *   task_claimed, message, error
 *
 * Part of Phase 5.0 (Pilot AGI-adl.2)
 */

// ============================================================================
// MESSAGE TYPE ENUMS
// ============================================================================

/** Messages sent from Agent to PM */
const AGENT_MSG_TYPES = {
  REGISTER: 'register',
  HEARTBEAT: 'heartbeat',
  TASK_COMPLETE: 'task_complete',
  ASK_PM: 'ask_pm',
  CHECKPOINT: 'checkpoint',
  REQUEST: 'request'
};

/** Messages sent from PM to Agent */
const PM_MSG_TYPES = {
  WELCOME: 'welcome',
  TASK_ASSIGN: 'task_assign',
  ANSWER: 'answer',
  PLAN_APPROVAL: 'plan_approval',
  COMMAND: 'command',
  SHUTDOWN: 'shutdown',
  TASK_CLAIMED: 'task_claimed',
  MESSAGE: 'message',
  ERROR: 'error'
};

/** All known message types */
const ALL_MSG_TYPES = new Set([
  ...Object.values(AGENT_MSG_TYPES),
  ...Object.values(PM_MSG_TYPES)
]);

// ============================================================================
// MESSAGE SCHEMAS
// ============================================================================

/**
 * Schema definitions for each message type.
 * Each schema has:
 *   required: string[] — fields that must be present
 *   optional: string[] — fields that may be present
 *   validate: (msg) => string|null — returns error string or null if valid
 */
const SCHEMAS = {
  // ── Agent → PM ──

  register: {
    required: ['type', 'sessionId'],
    optional: ['role', 'capabilities', 'taskId', 'pressure'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (msg.role !== undefined && typeof msg.role !== 'string') {
        return 'role must be a string';
      }
      if (msg.capabilities !== undefined && !Array.isArray(msg.capabilities)) {
        return 'capabilities must be an array';
      }
      return null;
    }
  },

  heartbeat: {
    required: ['type', 'sessionId'],
    optional: ['pressure', 'claimedTask', 'taskId'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (msg.pressure !== undefined && (typeof msg.pressure !== 'number' || msg.pressure < 0 || msg.pressure > 1)) {
        return 'pressure must be a number between 0 and 1';
      }
      return null;
    }
  },

  task_complete: {
    required: ['type', 'sessionId', 'taskId'],
    optional: ['result'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (typeof msg.taskId !== 'string' || !msg.taskId) {
        return 'taskId must be a non-empty string';
      }
      return null;
    }
  },

  ask_pm: {
    required: ['type', 'sessionId', 'question'],
    optional: ['requestId', 'context'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (typeof msg.question !== 'string' || !msg.question) {
        return 'question must be a non-empty string';
      }
      if (msg.context !== undefined && typeof msg.context !== 'object') {
        return 'context must be an object';
      }
      return null;
    }
  },

  checkpoint: {
    required: ['type', 'sessionId', 'taskId'],
    optional: ['step', 'state'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (typeof msg.taskId !== 'string' || !msg.taskId) {
        return 'taskId must be a non-empty string';
      }
      return null;
    }
  },

  request: {
    required: ['type', 'sessionId', 'topic'],
    optional: ['payload', 'requestId'],
    validate(msg) {
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        return 'sessionId must be a non-empty string';
      }
      if (typeof msg.topic !== 'string' || !msg.topic) {
        return 'topic must be a non-empty string';
      }
      return null;
    }
  },

  // ── PM → Agent ──

  welcome: {
    required: ['type'],
    optional: ['pmPort', 'pmSessionId', 'connectedAgents'],
    validate() { return null; }
  },

  task_assign: {
    required: ['type', 'taskId'],
    optional: ['context', 'priority'],
    validate(msg) {
      if (typeof msg.taskId !== 'string' || !msg.taskId) {
        return 'taskId must be a non-empty string';
      }
      return null;
    }
  },

  answer: {
    required: ['type'],
    optional: ['requestId', 'guidance', 'decision', 'follow_up', 'error'],
    validate() { return null; }
  },

  plan_approval: {
    required: ['type', 'taskId', 'approved'],
    optional: ['feedback'],
    validate(msg) {
      if (typeof msg.taskId !== 'string' || !msg.taskId) {
        return 'taskId must be a non-empty string';
      }
      if (typeof msg.approved !== 'boolean') {
        return 'approved must be a boolean';
      }
      return null;
    }
  },

  command: {
    required: ['type', 'action'],
    optional: ['params'],
    validate(msg) {
      if (typeof msg.action !== 'string' || !msg.action) {
        return 'action must be a non-empty string';
      }
      return null;
    }
  },

  shutdown: {
    required: ['type'],
    optional: ['reason'],
    validate() { return null; }
  },

  task_claimed: {
    required: ['type', 'taskId', 'claimedBy'],
    optional: [],
    validate(msg) {
      if (typeof msg.taskId !== 'string') return 'taskId must be a string';
      if (typeof msg.claimedBy !== 'string') return 'claimedBy must be a string';
      return null;
    }
  },

  message: {
    required: ['type', 'from'],
    optional: ['topic', 'payload'],
    validate(msg) {
      if (typeof msg.from !== 'string') return 'from must be a string';
      return null;
    }
  },

  error: {
    required: ['type', 'message'],
    optional: ['code'],
    validate(msg) {
      if (typeof msg.message !== 'string') return 'message must be a string';
      return null;
    }
  }
};

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate a message against its schema.
 * @param {object} msg — parsed message object
 * @returns {{ valid: boolean, error?: string }}
 */
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: 'Message must be a non-null object' };
  }

  if (!msg.type || typeof msg.type !== 'string') {
    return { valid: false, error: 'Message must have a string "type" field' };
  }

  const schema = SCHEMAS[msg.type];
  if (!schema) {
    return { valid: false, error: `Unknown message type: ${msg.type}` };
  }

  // Check required fields
  for (const field of schema.required) {
    if (msg[field] === undefined || msg[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Run type-specific validation
  const err = schema.validate(msg);
  if (err) {
    return { valid: false, error: err };
  }

  return { valid: true };
}

/**
 * Check if a message type is an Agent → PM message.
 * @param {string} type
 * @returns {boolean}
 */
function isAgentMessage(type) {
  return Object.values(AGENT_MSG_TYPES).includes(type);
}

/**
 * Check if a message type is a PM → Agent message.
 * @param {string} type
 * @returns {boolean}
 */
function isPmMessage(type) {
  return Object.values(PM_MSG_TYPES).includes(type);
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

/**
 * Build an Agent → PM register message.
 */
function buildRegister(sessionId, opts = {}) {
  return {
    type: AGENT_MSG_TYPES.REGISTER,
    sessionId,
    role: opts.role || 'general',
    capabilities: opts.capabilities || [],
    taskId: opts.taskId || null,
    pressure: opts.pressure || null
  };
}

/**
 * Build an Agent → PM heartbeat message.
 */
function buildHeartbeat(sessionId, opts = {}) {
  return {
    type: AGENT_MSG_TYPES.HEARTBEAT,
    sessionId,
    pressure: opts.pressure !== undefined ? opts.pressure : null,
    claimedTask: opts.claimedTask || opts.taskId || null
  };
}

/**
 * Build an Agent → PM task_complete message.
 */
function buildTaskComplete(sessionId, taskId, result) {
  return {
    type: AGENT_MSG_TYPES.TASK_COMPLETE,
    sessionId,
    taskId,
    result: result || {}
  };
}

/**
 * Build an Agent → PM ask_pm message.
 */
function buildAskPm(sessionId, question, opts = {}) {
  return {
    type: AGENT_MSG_TYPES.ASK_PM,
    sessionId,
    question,
    requestId: opts.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    context: opts.context || {}
  };
}

/**
 * Build an Agent → PM checkpoint message.
 */
function buildCheckpoint(sessionId, taskId, step, state) {
  return {
    type: AGENT_MSG_TYPES.CHECKPOINT,
    sessionId,
    taskId,
    step: step || null,
    state: state || {}
  };
}

/**
 * Build an Agent → PM request message.
 */
function buildRequest(sessionId, topic, payload) {
  return {
    type: AGENT_MSG_TYPES.REQUEST,
    sessionId,
    topic,
    payload: payload || {},
    requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  };
}

/**
 * Build a PM → Agent welcome message.
 */
function buildWelcome(opts = {}) {
  return {
    type: PM_MSG_TYPES.WELCOME,
    pmPort: opts.pmPort || null,
    pmSessionId: opts.pmSessionId || null,
    connectedAgents: opts.connectedAgents || 0
  };
}

/**
 * Build a PM → Agent task_assign message.
 */
function buildTaskAssign(taskId, context) {
  return {
    type: PM_MSG_TYPES.TASK_ASSIGN,
    taskId,
    context: context || {}
  };
}

/**
 * Build a PM → Agent answer message.
 */
function buildAnswer(requestId, opts = {}) {
  return {
    type: PM_MSG_TYPES.ANSWER,
    requestId,
    guidance: opts.guidance || null,
    decision: opts.decision || null,
    follow_up: opts.follow_up || null,
    error: opts.error || null
  };
}

/**
 * Build a PM → Agent plan_approval message.
 */
function buildPlanApproval(taskId, approved, feedback) {
  return {
    type: PM_MSG_TYPES.PLAN_APPROVAL,
    taskId,
    approved,
    feedback: feedback || null
  };
}

/**
 * Build a PM → Agent command message.
 */
function buildCommand(action, params) {
  return {
    type: PM_MSG_TYPES.COMMAND,
    action,
    params: params || {}
  };
}

/**
 * Build a PM → Agent shutdown message.
 */
function buildShutdown(reason) {
  return {
    type: PM_MSG_TYPES.SHUTDOWN,
    reason: reason || 'Requested by PM'
  };
}

/**
 * Build a PM → Agent error message.
 */
function buildError(message, code) {
  return {
    type: PM_MSG_TYPES.ERROR,
    message,
    code: code || null
  };
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/**
 * Serialize a message to JSON string. Validates before serializing.
 * @param {object} msg
 * @returns {{ data: string|null, error?: string }}
 */
function serialize(msg) {
  const result = validateMessage(msg);
  if (!result.valid) {
    return { data: null, error: result.error };
  }
  return { data: JSON.stringify(msg) };
}

/**
 * Deserialize and validate a JSON string into a message.
 * @param {string} data
 * @returns {{ msg: object|null, error?: string }}
 */
function deserialize(data) {
  if (typeof data !== 'string') {
    return { msg: null, error: 'Data must be a string' };
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    return { msg: null, error: `Invalid JSON: ${e.message}` };
  }

  const result = validateMessage(parsed);
  if (!result.valid) {
    return { msg: null, error: result.error };
  }

  return { msg: parsed };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Enums
  AGENT_MSG_TYPES,
  PM_MSG_TYPES,
  ALL_MSG_TYPES,

  // Validation
  validateMessage,
  isAgentMessage,
  isPmMessage,

  // Builders — Agent → PM
  buildRegister,
  buildHeartbeat,
  buildTaskComplete,
  buildAskPm,
  buildCheckpoint,
  buildRequest,

  // Builders — PM → Agent
  buildWelcome,
  buildTaskAssign,
  buildAnswer,
  buildPlanApproval,
  buildCommand,
  buildShutdown,
  buildError,

  // Serialization
  serialize,
  deserialize,

  // Schema (for testing)
  SCHEMAS
};
