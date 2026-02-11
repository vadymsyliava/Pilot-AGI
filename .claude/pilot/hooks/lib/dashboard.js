/**
 * Dashboard Data Collector
 *
 * Aggregates data from all Pilot AGI infrastructure modules into a single
 * structured object for the /pilot-dashboard skill. Designed for reuse
 * by a future web UI.
 *
 * Part of Phase 2.5 — Visibility Dashboard (Pilot AGI-6jn)
 */

const path = require('path');

// ============================================================================
// SAFE MODULE LOADERS
// Each data source is loaded in a try/catch so partial data is still returned
// if any module is unavailable.
// ============================================================================

function loadModule(name) {
  try {
    return require(`./${name}`);
  } catch (e) {
    return null;
  }
}

// ============================================================================
// DATA COLLECTION
// ============================================================================

/**
 * Collect all dashboard data into a single structured object.
 *
 * @returns {{
 *   agents: Array,
 *   tasks: { open: number, in_progress: number, closed: number, total: number, items: Array },
 *   locks: { areas: Array, files: Array },
 *   worktrees: Array,
 *   messaging: object,
 *   memory: Array,
 *   drift: Array,
 *   pressure: Array,
 *   events: Array,
 *   collected_at: string
 * }}
 */
function collect() {
  const orchestrator = loadModule('orchestrator');
  const session = loadModule('session');
  const messaging = loadModule('messaging');
  const memory = loadModule('memory');
  const pressure = loadModule('pressure');
  const worktree = loadModule('worktree');

  const result = {
    agents: [],
    tasks: { open: 0, in_progress: 0, closed: 0, total: 0, items: [] },
    locks: { areas: [], files: [] },
    worktrees: [],
    messaging: { bus_exists: false, bus_size_bytes: 0, message_count: 0, active_cursors: 0, needs_compaction: false },
    memory: [],
    drift: [],
    pressure: [],
    events: [],
    collected_at: new Date().toISOString()
  };

  // --- Agents & Health ---
  if (orchestrator) {
    try {
      result.agents = orchestrator.getAgentHealth();
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Tasks (via orchestrator's project overview which calls bd) ---
  if (orchestrator) {
    try {
      const overview = orchestrator.getProjectOverview();
      const all = overview.tasks.all || [];
      result.tasks = {
        open: all.filter(t => t.status === 'open').length,
        in_progress: all.filter(t => t.status === 'in_progress').length,
        closed: all.filter(t => t.status === 'closed').length,
        total: all.length,
        items: all
      };
      result.locks = overview.locks || { areas: [], files: [] };
      result.events = overview.recent_events || [];
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Worktrees ---
  if (worktree) {
    try {
      result.worktrees = worktree.listWorktrees();
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Messaging ---
  if (messaging) {
    try {
      result.messaging = messaging.getBusStats();
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Memory Channels ---
  if (memory) {
    try {
      result.memory = memory.listChannels();
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Drift Detection (per active agent with a task) ---
  if (orchestrator) {
    try {
      for (const agent of result.agents) {
        if (agent.claimed_task) {
          const drift = orchestrator.detectDrift(agent.session_id);
          result.drift.push({
            session_id: agent.session_id,
            task_id: agent.claimed_task,
            ...drift
          });
        }
      }
    } catch (e) {
      // partial data is fine
    }
  }

  // --- Context Pressure (per active agent) ---
  if (pressure) {
    try {
      for (const agent of result.agents) {
        const p = pressure.getPressure(agent.session_id);
        result.pressure.push({
          session_id: agent.session_id,
          calls: p.calls || 0,
          bytes: p.bytes || 0,
          pct_estimate: p.pct_estimate || 0
        });
      }
    } catch (e) {
      // partial data is fine
    }
  }

  return result;
}

// ============================================================================
// ALERT DETECTION
// ============================================================================

/**
 * Severity levels for alerts.
 */
const SEVERITY = {
  CRITICAL: 'critical',  // drift detected, agent unresponsive
  WARNING: 'warning',    // stale agent, lease expiring, high pressure
  INFO: 'info'           // bus compaction, channel updates
};

/**
 * Scan collected data for actionable conditions and return alerts.
 * Can accept pre-collected data to avoid double-fetching.
 *
 * @param {object} [data] - Pre-collected data from collect(). If omitted, calls collect().
 * @returns {Array<{ severity: string, type: string, message: string, details: object }>}
 */
function getAlerts(data) {
  if (!data) {
    data = collect();
  }

  const alerts = [];

  // --- Drift Detected ---
  for (const d of data.drift) {
    if (d.drifted) {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        type: 'drift_detected',
        message: `Agent ${d.session_id} drifted from plan on task ${d.task_id} (score: ${d.score})`,
        details: {
          session_id: d.session_id,
          task_id: d.task_id,
          score: d.score,
          unplanned: d.unplanned || []
        }
      });
    }
  }

  // --- Agent Health Issues ---
  for (const agent of data.agents) {
    if (agent.status === 'unresponsive') {
      alerts.push({
        severity: SEVERITY.CRITICAL,
        type: 'agent_unresponsive',
        message: `Agent ${agent.session_id} is unresponsive (heartbeat: ${agent.heartbeat_age_sec}s ago)`,
        details: {
          session_id: agent.session_id,
          heartbeat_age_sec: agent.heartbeat_age_sec,
          claimed_task: agent.claimed_task
        }
      });
    } else if (agent.status === 'stale') {
      alerts.push({
        severity: SEVERITY.WARNING,
        type: 'agent_stale',
        message: `Agent ${agent.session_id} is stale (heartbeat: ${agent.heartbeat_age_sec}s ago)`,
        details: {
          session_id: agent.session_id,
          heartbeat_age_sec: agent.heartbeat_age_sec,
          claimed_task: agent.claimed_task
        }
      });
    } else if (agent.status === 'lease_expired') {
      alerts.push({
        severity: SEVERITY.WARNING,
        type: 'lease_expired',
        message: `Agent ${agent.session_id} lease expired on task ${agent.claimed_task}`,
        details: {
          session_id: agent.session_id,
          claimed_task: agent.claimed_task
        }
      });
    }

    // Lease expiring soon (< 5 minutes remaining)
    if (agent.status === 'healthy' && agent.lease_remaining_sec !== null && agent.lease_remaining_sec < 300) {
      alerts.push({
        severity: SEVERITY.WARNING,
        type: 'lease_expiring_soon',
        message: `Agent ${agent.session_id} lease expires in ${agent.lease_remaining_sec}s`,
        details: {
          session_id: agent.session_id,
          lease_remaining_sec: agent.lease_remaining_sec,
          claimed_task: agent.claimed_task
        }
      });
    }
  }

  // --- High Context Pressure ---
  for (const p of data.pressure) {
    if (p.pct_estimate >= 80) {
      alerts.push({
        severity: SEVERITY.WARNING,
        type: 'high_context_pressure',
        message: `Agent ${p.session_id} context pressure at ${p.pct_estimate}% (${p.calls} calls)`,
        details: {
          session_id: p.session_id,
          pct_estimate: p.pct_estimate,
          calls: p.calls
        }
      });
    }
  }

  // --- Bus Compaction Needed ---
  if (data.messaging.needs_compaction) {
    alerts.push({
      severity: SEVERITY.INFO,
      type: 'bus_compaction_needed',
      message: `Message bus needs compaction (${data.messaging.bus_size_bytes} bytes, ${data.messaging.message_count} messages)`,
      details: data.messaging
    });
  }

  return alerts;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  collect,
  getAlerts,
  SEVERITY
};
