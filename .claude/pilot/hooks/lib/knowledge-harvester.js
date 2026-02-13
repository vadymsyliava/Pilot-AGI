/**
 * Knowledge Harvester (Phase 5.8)
 *
 * Extracts learnings from completed tasks and publishes them
 * to the global cross-project knowledge base.
 *
 * Sources:
 *   - Decomposition patterns (from decomposition-patterns.js)
 *   - Failure modes (from escalation logs)
 *   - Tech decisions (from memory channels)
 *   - Cost benchmarks (from cost-tracker)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// =============================================================================
// PRIVACY POLICY LOADING
// =============================================================================

/**
 * Load cross-project policy from policy.yaml.
 * @param {string} [projectPath] - Project root directory
 * @returns {object} Cross-project policy config
 */
function loadCrossProjectPolicy(projectPath) {
  const defaults = {
    enabled: false,
    publish: false,
    consume: false,
    anonymize_level: 'full',
    exclude_patterns: ['*.env', '*secret*', '*password*', '*token*'],
    knowledge_path: null,
    max_entries_per_type: 500,
    prune_after_days: 90
  };

  try {
    const { loadPolicy } = require('./policy');
    const policy = loadPolicy(projectPath);
    const cp = policy.cross_project || {};

    return {
      enabled: cp.enabled === true,
      publish: cp.publish === true,
      consume: cp.consume === true,
      anonymize_level: cp.anonymize_level || defaults.anonymize_level,
      exclude_patterns: cp.exclude_patterns || defaults.exclude_patterns,
      knowledge_path: cp.knowledge_path || defaults.knowledge_path,
      max_entries_per_type: cp.max_entries_per_type || defaults.max_entries_per_type,
      prune_after_days: cp.prune_after_days || defaults.prune_after_days
    };
  } catch (e) {
    return defaults;
  }
}

/**
 * Get the project name from the directory path.
 * @param {string} projectPath
 * @returns {string}
 */
function getProjectName(projectPath) {
  return path.basename(projectPath || process.cwd());
}

// =============================================================================
// HARVESTING FROM TASK
// =============================================================================

/**
 * Harvest knowledge from a completed task.
 * Extracts decomposition templates, failure modes, tech decisions,
 * and cost benchmarks, then publishes to global knowledge base.
 *
 * @param {string} taskId - Completed task ID
 * @param {string} [projectPath] - Project root directory
 * @returns {{ harvested: object, published: object[], skipped: string[] }}
 */
function harvestFromTask(taskId, projectPath) {
  projectPath = projectPath || process.cwd();
  const policy = loadCrossProjectPolicy(projectPath);
  const published = [];
  const skipped = [];
  const harvested = {};

  if (!policy.enabled || !policy.publish) {
    return { harvested, published, skipped: ['policy_disabled'] };
  }

  const knowledge = require('./cross-project-knowledge');
  const opts = {
    knowledgePath: policy.knowledge_path || undefined,
    anonymizeLevel: policy.anonymize_level,
    excludePatterns: policy.exclude_patterns
  };
  const projectName = getProjectName(projectPath);

  // --- Harvest decomposition template ---
  try {
    const template = _extractDecompositionTemplate(taskId, projectPath);
    if (template) {
      harvested.decomposition = template;
      const result = knowledge.publishKnowledge(
        'decomposition-templates', template, projectName, opts
      );
      if (result.excluded) {
        skipped.push('decomposition-templates:excluded');
      } else {
        published.push({ type: 'decomposition-templates', id: result.id, deduplicated: result.deduplicated });
      }
    }
  } catch (e) {
    skipped.push('decomposition-templates:error');
  }

  // --- Harvest failure modes ---
  try {
    const failures = _extractFailureModes(taskId, projectPath);
    if (failures && failures.length > 0) {
      harvested.failures = failures;
      for (const failure of failures) {
        const result = knowledge.publishKnowledge(
          'failure-modes', failure, projectName, opts
        );
        if (result.excluded) {
          skipped.push('failure-modes:excluded');
        } else {
          published.push({ type: 'failure-modes', id: result.id, deduplicated: result.deduplicated });
        }
      }
    }
  } catch (e) {
    skipped.push('failure-modes:error');
  }

  // --- Harvest tech decisions ---
  try {
    const decisions = _extractTechDecisions(taskId, projectPath);
    if (decisions && decisions.length > 0) {
      harvested.decisions = decisions;
      for (const decision of decisions) {
        const result = knowledge.publishKnowledge(
          'tech-decisions', decision, projectName, opts
        );
        if (result.excluded) {
          skipped.push('tech-decisions:excluded');
        } else {
          published.push({ type: 'tech-decisions', id: result.id, deduplicated: result.deduplicated });
        }
      }
    }
  } catch (e) {
    skipped.push('tech-decisions:error');
  }

  // --- Harvest cost benchmarks ---
  try {
    const costBenchmark = _extractCostBenchmark(taskId, projectPath);
    if (costBenchmark) {
      harvested.cost = costBenchmark;
      const result = knowledge.publishKnowledge(
        'cost-benchmarks', costBenchmark, projectName, opts
      );
      if (result.excluded) {
        skipped.push('cost-benchmarks:excluded');
      } else {
        published.push({ type: 'cost-benchmarks', id: result.id, deduplicated: result.deduplicated });
      }
    }
  } catch (e) {
    skipped.push('cost-benchmarks:error');
  }

  return { harvested, published, skipped };
}

/**
 * Bulk harvest from an entire project's history.
 *
 * @param {string} [projectPath]
 * @returns {{ tasks_scanned: number, published: number, errors: number }}
 */
function harvestFromProject(projectPath) {
  projectPath = projectPath || process.cwd();
  const policy = loadCrossProjectPolicy(projectPath);

  if (!policy.enabled || !policy.publish) {
    return { tasks_scanned: 0, published: 0, errors: 0 };
  }

  let tasksScanned = 0;
  let totalPublished = 0;
  let errors = 0;

  // Scan cost tracker task files for completed task IDs
  const tasksDir = path.join(projectPath, '.claude/pilot/state/costs/tasks');
  if (fs.existsSync(tasksDir)) {
    try {
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const taskId = f.replace('.json', '').replace(/_/g, ' ');
        tasksScanned++;
        try {
          const result = harvestFromTask(taskId, projectPath);
          totalPublished += result.published.length;
        } catch (e) {
          errors++;
        }
      }
    } catch (e) {
      errors++;
    }
  }

  return { tasks_scanned: tasksScanned, published: totalPublished, errors };
}

// =============================================================================
// EXTRACTION HELPERS
// =============================================================================

/**
 * Extract decomposition template from a completed task.
 * @private
 */
function _extractDecompositionTemplate(taskId, projectPath) {
  try {
    const decompositionPatterns = require('./decomposition-patterns');
    const library = decompositionPatterns.loadLibrary();
    const pattern = library.patterns.find(p => p.source_task_id === taskId);
    if (!pattern) return null;

    return {
      task_type: pattern.type,
      keywords: pattern.keywords,
      domain: pattern.domain,
      template: pattern.template,
      success_rate: pattern.success_rate,
      avg_subtasks: pattern.avg_subtasks,
      avg_accuracy: pattern.avg_accuracy
    };
  } catch (e) {
    return null;
  }
}

/**
 * Extract failure modes from escalation logs.
 * @private
 */
function _extractFailureModes(taskId, projectPath) {
  const failures = [];
  const logPath = path.join(projectPath, '.claude/pilot/state/escalations/log.jsonl');

  if (!fs.existsSync(logPath)) return failures;

  try {
    const content = fs.readFileSync(logPath, 'utf8').trim();
    if (!content) return failures;

    const entries = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);

    // Find escalations related to this task
    const taskEntries = entries.filter(e =>
      e.taskId === taskId || e.task_id === taskId
    );

    for (const entry of taskEntries) {
      failures.push({
        event_type: entry.eventType || entry.event_type,
        level: entry.level,
        context: entry.context || {},
        resolution: entry.action || 'unknown'
      });
    }
  } catch (e) {
    // best effort
  }

  return failures;
}

/**
 * Extract tech decisions from memory channels.
 * @private
 */
function _extractTechDecisions(taskId, projectPath) {
  const decisions = [];

  try {
    const memory = require('./memory');
    const agentTypes = memory.listAgentTypes();

    for (const agentType of agentTypes) {
      const agentDecisions = memory.getDecisions(agentType, { task_id: taskId });
      for (const d of agentDecisions) {
        decisions.push({
          decision: d.decision,
          reason: d.reason,
          alternatives: d.alternatives_considered,
          agent_role: agentType
        });
      }
    }
  } catch (e) {
    // best effort
  }

  return decisions;
}

/**
 * Extract cost benchmarks from cost tracker.
 * @private
 */
function _extractCostBenchmark(taskId, projectPath) {
  try {
    const costTracker = require('./cost-tracker');
    const taskCost = costTracker.getTaskCost(taskId);
    if (!taskCost || taskCost.total_tokens === 0) return null;

    // Try to get task type
    let taskType = 'unknown';
    try {
      const decompositionPatterns = require('./decomposition-patterns');
      const library = decompositionPatterns.loadLibrary();
      const pattern = library.patterns.find(p => p.source_task_id === taskId);
      if (pattern) taskType = pattern.type;
    } catch (e) { /* best effort */ }

    return {
      task_type: taskType,
      total_tokens: taskCost.total_tokens,
      total_calls: taskCost.total_calls,
      cost_usd: taskCost.cost_usd,
      sessions_count: Object.keys(taskCost.sessions || {}).length
    };
  } catch (e) {
    return null;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Harvesting
  harvestFromTask,
  harvestFromProject,

  // Policy
  loadCrossProjectPolicy,

  // Helpers (exported for testing)
  getProjectName,
  _extractDecompositionTemplate,
  _extractFailureModes,
  _extractTechDecisions,
  _extractCostBenchmark
};
