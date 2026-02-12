/**
 * PM Knowledge Base — context gatherer for PM Brain
 *
 * Reads from 15 disk sources with TTL-based caching.
 * All reads wrapped in try/catch for graceful degradation.
 *
 * TTL tiers:
 *   - Session states, task graph: 30s (volatile)
 *   - Memory channels, escalations: 60s (moderate)
 *   - Project docs, roadmap, plans: 300s (stable)
 *
 * Part of Phase 5.0 (Pilot AGI-adl.4)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// LAZY DEPS (same pattern as spawn-context.js)
// ============================================================================

let _session = null;
let _memory = null;
let _costTracker = null;
let _artifactRegistry = null;

function getSession() {
  if (!_session) {
    try { _session = require('./session'); } catch (e) { _session = null; }
  }
  return _session;
}

function getMemory() {
  if (!_memory) {
    try { _memory = require('./memory'); } catch (e) { _memory = null; }
  }
  return _memory;
}

function getCostTracker() {
  if (!_costTracker) {
    try { _costTracker = require('./cost-tracker'); } catch (e) { _costTracker = null; }
  }
  return _costTracker;
}

function getArtifactRegistry() {
  if (!_artifactRegistry) {
    try { _artifactRegistry = require('./artifact-registry'); } catch (e) { _artifactRegistry = null; }
  }
  return _artifactRegistry;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TTL_VOLATILE_MS = 30000;   // 30s — session states, task graph
const TTL_MODERATE_MS = 60000;   // 60s — memory channels, escalations, cost
const TTL_STABLE_MS = 300000;    // 5min — project docs, roadmap, plans
const BD_TIMEOUT_MS = 5000;
const MAX_TEXT_SIZE = 3000;      // cap per source for prompt budget

// ============================================================================
// PM KNOWLEDGE BASE
// ============================================================================

class PmKnowledgeBase {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this._cache = {};
  }

  /**
   * Gather PM knowledge for brain prompts.
   *
   * @param {object} opts
   * @param {string} opts.topic — filter research by topic
   * @param {string} opts.taskId — include task-specific plan and artifacts
   * @param {string} opts.agentId — include agent-specific data
   * @returns {object} Structured knowledge object
   */
  gather(opts = {}) {
    return {
      // Stable sources (5min TTL)
      projectName: this._readProjectName(),
      productBrief: this._readProductBrief(),
      currentMilestone: this._readCurrentMilestone(),
      currentPhase: this._readCurrentPhase(),
      sprintPlan: this._readActiveSprint(),
      activePlans: this._readActivePlans(opts.taskId),

      // Moderate sources (60s TTL)
      recentDecisions: this._readRecentDecisions(20),
      relevantResearch: this._readResearch(opts.topic),
      taskDecompositions: this._readTaskDecompositions(opts.taskId),
      workingContext: this._readWorkingContext(),
      escalationHistory: this._readEscalations(10),
      budgetUsedToday: this._readBudgetUsed(),
      artifacts: this._readArtifacts(opts.taskId),
      pmActionLog: this._readPmActionLog(20),

      // Volatile sources (30s TTL)
      activeAgents: this._readActiveAgents(opts.agentId),
      tasksInProgress: this._readTasksByStatus('in_progress'),
      tasksBlocked: this._readTasksByStatus('blocked'),
      taskSummary: this._readTaskSummary(),
      agentPlan: this._readAgentPlan(opts.taskId)
    };
  }

  /**
   * Record a new PM decision (persisted to pm-decisions memory channel).
   */
  recordDecision(decision) {
    decision.ts = decision.ts || new Date().toISOString();

    const mem = getMemory();
    if (!mem) return;

    try {
      mem.publish('pm-decisions', {
        decisions: [decision]
      }, { sessionId: 'pm-daemon', summary: `PM decision: ${decision.type}` });
    } catch (e) {
      // Best effort — don't fail brain calls over persistence
    }
  }

  /**
   * Clear the internal cache (useful for testing or forced refresh).
   */
  clearCache() {
    this._cache = {};
  }

  // ==========================================================================
  // INTERNAL: Cache helper
  // ==========================================================================

  _readWithCache(key, ttlMs, fn) {
    const now = Date.now();
    const entry = this._cache[key];
    if (entry && (now - entry.ts) < ttlMs) {
      return entry.value;
    }

    let value;
    try {
      value = fn();
    } catch (e) {
      value = entry ? entry.value : null; // stale cache on error
    }

    this._cache[key] = { value, ts: now };
    return value;
  }

  _cap(text, limit) {
    if (!text) return '';
    return text.length > limit ? text.substring(0, limit) + '\n[...truncated]' : text;
  }

  // ==========================================================================
  // STABLE SOURCES (5min TTL)
  // ==========================================================================

  _readProjectName() {
    return this._readWithCache('projectName', TTL_STABLE_MS, () => {
      const briefPath = path.join(this.projectRoot, 'work/PROJECT_BRIEF.md');
      if (!fs.existsSync(briefPath)) return 'Pilot AGI';
      const content = fs.readFileSync(briefPath, 'utf8');
      const match = content.match(/^#\s+(.+)/m);
      return match ? match[1].trim() : 'Pilot AGI';
    });
  }

  _readProductBrief() {
    return this._readWithCache('productBrief', TTL_STABLE_MS, () => {
      const briefPath = path.join(this.projectRoot, 'work/PROJECT_BRIEF.md');
      if (!fs.existsSync(briefPath)) return '';
      return this._cap(fs.readFileSync(briefPath, 'utf8'), 2000);
    });
  }

  _readCurrentMilestone() {
    return this._readWithCache('currentMilestone', TTL_STABLE_MS, () => {
      const roadmapPath = path.join(this.projectRoot, 'work/ROADMAP.md');
      if (!fs.existsSync(roadmapPath)) return 'Unknown';
      const content = fs.readFileSync(roadmapPath, 'utf8');
      const match = content.match(/##\s+(?:Milestone\s+)?(\S+[^\n]*?)(?:\n[\s\S]*?Status:\s*(?:Active|IN PROGRESS))/i);
      return match ? match[1].trim() : 'Unknown';
    });
  }

  _readCurrentPhase() {
    return this._readWithCache('currentPhase', TTL_STABLE_MS, () => {
      const roadmapPath = path.join(this.projectRoot, 'work/ROADMAP.md');
      if (!fs.existsSync(roadmapPath)) return 'Unknown';
      const content = fs.readFileSync(roadmapPath, 'utf8');
      const match = content.match(/###\s+Phase\s+(\S+[^\n]*?)(?:\n[\s\S]*?Status:\s*(?:Active|IN PROGRESS))/i);
      return match ? match[1].trim() : 'Unknown';
    });
  }

  _readActiveSprint() {
    return this._readWithCache('sprintPlan', TTL_STABLE_MS, () => {
      const sprintDir = path.join(this.projectRoot, 'work/sprints');
      if (!fs.existsSync(sprintDir)) return '';

      try {
        const files = fs.readdirSync(sprintDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse(); // most recent first

        if (files.length === 0) return '';

        // Read the most recent sprint file
        const content = fs.readFileSync(path.join(sprintDir, files[0]), 'utf8');
        return this._cap(content, MAX_TEXT_SIZE);
      } catch (e) {
        return '';
      }
    });
  }

  _readActivePlans(taskId) {
    return this._readWithCache(`activePlans_${taskId || 'all'}`, TTL_STABLE_MS, () => {
      const plansDir = path.join(this.projectRoot, 'work/plans');
      if (!fs.existsSync(plansDir)) return '';

      try {
        const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));

        // If taskId specified, prioritize that plan
        if (taskId) {
          const taskPlan = files.find(f => f.includes(taskId));
          if (taskPlan) {
            return this._cap(fs.readFileSync(path.join(plansDir, taskPlan), 'utf8'), MAX_TEXT_SIZE);
          }
        }

        // Otherwise, concatenate recent plans (capped)
        const summaries = [];
        let totalLen = 0;
        for (const f of files.slice(-5).reverse()) {
          const content = fs.readFileSync(path.join(plansDir, f), 'utf8');
          const summary = content.substring(0, 500);
          if (totalLen + summary.length > MAX_TEXT_SIZE) break;
          summaries.push(`### ${f}\n${summary}`);
          totalLen += summary.length;
        }
        return summaries.join('\n\n');
      } catch (e) {
        return '';
      }
    });
  }

  // ==========================================================================
  // MODERATE SOURCES (60s TTL)
  // ==========================================================================

  _readRecentDecisions(count) {
    return this._readWithCache('recentDecisions', TTL_MODERATE_MS, () => {
      const mem = getMemory();
      if (!mem) return [];
      try {
        const channel = mem.read('pm-decisions');
        if (channel && channel.data && channel.data.decisions) {
          return channel.data.decisions.slice(-count);
        }
      } catch (e) { /* ignore */ }
      return [];
    });
  }

  _readResearch(topic) {
    return this._readWithCache(`research_${topic || 'all'}`, TTL_MODERATE_MS, () => {
      const mem = getMemory();
      if (!mem) return '';
      try {
        const channel = mem.read('research-findings');
        if (!channel || !channel.data) return '';
        const text = JSON.stringify(channel.data, null, 2);
        return this._cap(text, MAX_TEXT_SIZE);
      } catch (e) {
        return '';
      }
    });
  }

  _readTaskDecompositions(taskId) {
    return this._readWithCache(`taskDecomps_${taskId || 'all'}`, TTL_MODERATE_MS, () => {
      const mem = getMemory();
      if (!mem) return '';
      try {
        const channel = mem.read('task-decompositions');
        if (!channel || !channel.data) return '';

        // If taskId, filter for relevant decompositions
        if (taskId && channel.data.decompositions) {
          const relevant = channel.data.decompositions.filter(d =>
            d.taskId === taskId || d.parentId === taskId
          );
          if (relevant.length > 0) {
            return this._cap(JSON.stringify(relevant, null, 2), MAX_TEXT_SIZE);
          }
        }

        return this._cap(JSON.stringify(channel.data, null, 2), MAX_TEXT_SIZE);
      } catch (e) {
        return '';
      }
    });
  }

  _readWorkingContext() {
    return this._readWithCache('workingContext', TTL_MODERATE_MS, () => {
      const mem = getMemory();
      if (!mem) return '';
      try {
        const channel = mem.read('working-context');
        if (!channel || !channel.data) return '';
        return this._cap(JSON.stringify(channel.data, null, 2), MAX_TEXT_SIZE);
      } catch (e) {
        return '';
      }
    });
  }

  _readEscalations(count) {
    return this._readWithCache('escalations', TTL_MODERATE_MS, () => {
      const logPath = path.join(this.projectRoot, '.claude/pilot/state/escalations/log.jsonl');
      if (!fs.existsSync(logPath)) return [];
      try {
        const content = fs.readFileSync(logPath, 'utf8').trim();
        if (!content) return [];
        const lines = content.split('\n').slice(-count);
        return lines.map(l => {
          try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
      } catch (e) {
        return [];
      }
    });
  }

  _readBudgetUsed() {
    return this._readWithCache('budgetUsed', TTL_MODERATE_MS, () => {
      const ct = getCostTracker();
      if (!ct) return 'N/A';
      try {
        const daily = ct.getDailyCost(this.projectRoot);
        return `$${(daily / 100).toFixed(2)}`;
      } catch (e) {
        return 'N/A';
      }
    });
  }

  _readArtifacts(taskId) {
    return this._readWithCache(`artifacts_${taskId || 'all'}`, TTL_MODERATE_MS, () => {
      const ar = getArtifactRegistry();
      if (!ar) return [];

      try {
        if (taskId) {
          // Get artifacts for specific task
          const manifest = ar.getManifest(this.projectRoot, taskId);
          if (manifest) return [manifest];
        }

        // List all artifact manifests
        const artifactDir = path.join(this.projectRoot, '.claude/pilot/state/artifacts');
        if (!fs.existsSync(artifactDir)) return [];

        const taskDirs = fs.readdirSync(artifactDir).filter(d => {
          const stat = fs.statSync(path.join(artifactDir, d));
          return stat.isDirectory();
        });

        const manifests = [];
        for (const td of taskDirs.slice(-10)) {
          const mfPath = path.join(artifactDir, td, 'manifest.json');
          if (fs.existsSync(mfPath)) {
            try {
              manifests.push(JSON.parse(fs.readFileSync(mfPath, 'utf8')));
            } catch (e) { /* skip bad manifests */ }
          }
        }
        return manifests;
      } catch (e) {
        return [];
      }
    });
  }

  _readPmActionLog(count) {
    return this._readWithCache('pmActionLog', TTL_MODERATE_MS, () => {
      const logPath = path.join(this.projectRoot, '.claude/pilot/state/orchestrator/action-log.jsonl');
      if (!fs.existsSync(logPath)) return [];
      try {
        const content = fs.readFileSync(logPath, 'utf8').trim();
        if (!content) return [];
        const lines = content.split('\n').slice(-count);
        return lines.map(l => {
          try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
      } catch (e) {
        return [];
      }
    });
  }

  // ==========================================================================
  // VOLATILE SOURCES (30s TTL)
  // ==========================================================================

  _readActiveAgents(agentId) {
    return this._readWithCache(`activeAgents_${agentId || 'all'}`, TTL_VOLATILE_MS, () => {
      const sess = getSession();
      if (!sess) return [];
      try {
        const sessions = sess.getAllSessionStates();
        const active = sessions.filter(s => s.status === 'active');

        if (agentId) {
          // Prioritize requested agent's data
          const agent = active.find(a => a.session_id === agentId || a.agent_name === agentId);
          if (agent) {
            return [agent, ...active.filter(a => a !== agent)];
          }
        }

        return active;
      } catch (e) {
        return [];
      }
    });
  }

  _readTasksByStatus(status) {
    return this._readWithCache(`tasks_${status}`, TTL_VOLATILE_MS, () => {
      try {
        const { execFileSync } = require('child_process');
        const output = execFileSync('bd', ['list', '--status', status, '--json'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          timeout: BD_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        return JSON.parse(output);
      } catch (e) {
        return [];
      }
    });
  }

  _readTaskSummary() {
    return this._readWithCache('taskSummary', TTL_VOLATILE_MS, () => {
      try {
        const { execFileSync } = require('child_process');
        const output = execFileSync('bd', ['list', '--json'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          timeout: BD_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const tasks = JSON.parse(output);
        return tasks.map(t => `${t.id} [${t.status}] ${t.title || t.summary || ''}`).join('\n');
      } catch (e) {
        return 'Task graph unavailable';
      }
    });
  }

  _readAgentPlan(taskId) {
    if (!taskId) return '';
    return this._readWithCache(`plan_${taskId}`, TTL_VOLATILE_MS, () => {
      const planPath = path.join(this.projectRoot, `work/plans/${taskId}.md`);
      if (!fs.existsSync(planPath)) return '';
      return this._cap(fs.readFileSync(planPath, 'utf8'), MAX_TEXT_SIZE);
    });
  }
}

module.exports = { PmKnowledgeBase, TTL_VOLATILE_MS, TTL_MODERATE_MS, TTL_STABLE_MS };
