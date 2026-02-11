/**
 * PM Pressure Monitor (Phase 3.5)
 *
 * Monitors context pressure across all active agent sessions.
 * PM can proactively nudge agents approaching their context limit.
 *
 * Designed to be called from the PM watcher loop periodically.
 */

const fs = require('fs');
const path = require('path');

const SESSION_STATE_DIR = '.claude/pilot/state/sessions';
const PM_NUDGE_THRESHOLD = 70; // Nudge agents at 70% (auto-checkpoint triggers at 60%)

// =============================================================================
// PRESSURE MONITORING
// =============================================================================

/**
 * Check all active agents' pressure levels.
 * Returns agents that are above the nudge threshold.
 *
 * @param {string} projectRoot
 * @returns {{ alerts: Array<{ session_id, pct, calls, bytes, task_id }>, healthy: number }}
 */
function checkAllAgentPressure(projectRoot) {
  const sessDir = path.join(projectRoot, SESSION_STATE_DIR);
  if (!fs.existsSync(sessDir)) {
    return { alerts: [], healthy: 0 };
  }

  const alerts = [];
  let healthy = 0;

  try {
    // Find all pressure files
    const pressureFiles = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.pressure.json'));

    for (const pf of pressureFiles) {
      try {
        const pressureData = JSON.parse(
          fs.readFileSync(path.join(sessDir, pf), 'utf8')
        );

        // Calculate percentage
        const bytes = pressureData.bytes || 0;
        const estimatedCapacity = 800 * 1024; // Same as pressure.js
        const pct = Math.min(100, Math.round((bytes / estimatedCapacity) * 100));

        // Extract session ID from filename (S-xxx.pressure.json → S-xxx)
        const sessionId = pf.replace('.pressure.json', '');

        // Check if session is still active
        const sessFile = path.join(sessDir, `${sessionId}.json`);
        let taskId = null;
        let isActive = false;

        if (fs.existsSync(sessFile)) {
          try {
            const sessData = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
            isActive = sessData.status === 'active';
            taskId = sessData.claimed_task || null;
          } catch (e) {
            // Can't read session — skip
            continue;
          }
        }

        if (!isActive) continue;

        if (pct >= PM_NUDGE_THRESHOLD) {
          alerts.push({
            session_id: sessionId,
            pct,
            calls: pressureData.calls || 0,
            bytes,
            task_id: taskId,
            last_nudge_pct: pressureData.last_nudge_pct || 0
          });
        } else {
          healthy++;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    // Best effort
  }

  return { alerts, healthy };
}

/**
 * Send nudge messages to agents with high pressure.
 * Uses the messaging bus to send blocking priority messages.
 *
 * @param {string} projectRoot
 * @param {string} pmSessionId - PM's session ID (sender)
 * @param {Array} alerts - From checkAllAgentPressure()
 * @returns {number} Number of nudges sent
 */
function sendPressureNudges(projectRoot, pmSessionId, alerts) {
  let sent = 0;

  try {
    const messaging = require('./messaging');

    for (const alert of alerts) {
      // Don't re-nudge if already nudged at this level
      if (alert.last_nudge_pct >= alert.pct - 5) continue;

      messaging.sendNotification(
        pmSessionId,
        alert.session_id,
        'pressure_warning',
        {
          pct: alert.pct,
          calls: alert.calls,
          task_id: alert.task_id,
          message: `Context pressure at ${alert.pct}%. Auto-checkpoint should have triggered at 60%. If it didn't, run /pilot-checkpoint then /compact.`
        }
      );
      sent++;
    }
  } catch (e) {
    // Best effort
  }

  return sent;
}

// =============================================================================
// PM SELF-MANAGEMENT (Phase 3.5 - Subtask 5)
// =============================================================================

/**
 * Build PM-specific checkpoint data.
 * Captures orchestrator state that's critical for PM continuity.
 *
 * @param {string} projectRoot
 * @returns {object} PM checkpoint data
 */
function buildPmCheckpointData(projectRoot) {
  const data = {
    task_id: 'PM-orchestrator',
    task_title: 'PM Orchestrator State',
    files_modified: [],
    current_context: '',
    key_decisions: [],
    important_findings: []
  };

  // 1. Active agent assignments
  try {
    const sessDir = path.join(projectRoot, SESSION_STATE_DIR);
    const sessFiles = fs.readdirSync(sessDir)
      .filter(f => f.startsWith('S-') && f.endsWith('.json') && !f.includes('.pressure'));

    const assignments = [];
    for (const f of sessFiles) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (s.status === 'active' && s.claimed_task) {
          assignments.push(`${s.session_id}: ${s.claimed_task}`);
        }
      } catch (e) { continue; }
    }
    data.key_decisions.push(`Active assignments: ${assignments.join(', ') || 'none'}`);
  } catch (e) {
    // Skip
  }

  // 2. PM action queue state
  try {
    const injector = require('./stdin-injector');
    const queueStats = injector.getQueueStats(projectRoot);
    data.key_decisions.push(`Action queue: ${queueStats.pending} pending, ${queueStats.processing} processing`);
  } catch (e) {
    // Skip
  }

  // 3. Recent PM decisions from memory channel
  try {
    const memory = require('./memory');
    const pmChannel = memory.read('pm-decisions');
    if (pmChannel && pmChannel.data && pmChannel.data.decisions) {
      const recent = pmChannel.data.decisions.slice(-5);
      data.important_findings = recent.map(d =>
        `${d.type}: ${d.task_id || ''} → ${d.decision || d.assigned_to || 'unknown'}`
      );
    }
  } catch (e) {
    // Skip
  }

  // 4. Bus health
  try {
    const messaging = require('./messaging');
    const stats = messaging.getBusStats();
    data.current_context = `Bus: ${stats.message_count} msgs, ${Math.round(stats.bus_size_bytes / 1024)}KB` +
      (stats.needs_compaction ? ' (needs compaction)' : '');
  } catch (e) {
    data.current_context = 'PM orchestrator checkpoint (bus stats unavailable)';
  }

  return data;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  checkAllAgentPressure,
  sendPressureNudges,
  buildPmCheckpointData,
  PM_NUDGE_THRESHOLD
};
