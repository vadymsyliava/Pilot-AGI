/**
 * Knowledge Consumer (Phase 5.8)
 *
 * Loads cross-project knowledge into agent context before task
 * execution. Enriches task decomposition, planning, and tech
 * decisions with learnings from other projects.
 */

const path = require('path');

// =============================================================================
// KNOWLEDGE RETRIEVAL
// =============================================================================

/**
 * Get relevant knowledge for a task from the global knowledge base.
 *
 * @param {string} taskDescription - Task title + description text
 * @param {string[]} [types] - Knowledge types to query (null = all)
 * @param {object} [opts] - { projectPath, limit }
 * @returns {object[]} Relevant knowledge entries
 */
function getRelevantKnowledge(taskDescription, types, opts) {
  opts = opts || {};
  const projectPath = opts.projectPath || process.cwd();

  // Check policy
  const { loadCrossProjectPolicy } = require('./knowledge-harvester');
  const policy = loadCrossProjectPolicy(projectPath);

  if (!policy.enabled || !policy.consume) {
    return [];
  }

  const knowledge = require('./cross-project-knowledge');
  const knowledgeOpts = {
    knowledgePath: policy.knowledge_path || undefined
  };

  // Extract keywords from task description
  const keywords = knowledge.extractKeywords(taskDescription);
  const limit = opts.limit || 5;

  if (!types || types.length === 0) {
    // Query all types
    return knowledge.queryKnowledge(null, keywords, limit, knowledgeOpts);
  }

  // Query each type and merge results
  const results = [];
  for (const type of types) {
    const entries = knowledge.queryKnowledge(type, keywords, limit, knowledgeOpts);
    results.push(...entries);
  }

  // Sort by score and deduplicate
  results.sort((a, b) => (b._score || 0) - (a._score || 0));
  return results.slice(0, limit);
}

/**
 * Enrich a task context with relevant cross-project knowledge.
 * Merges knowledge entries into the task's context object.
 *
 * @param {object} task - Task object with { id, title, description }
 * @param {object[]} [knowledgeEntries] - Pre-fetched knowledge entries (optional)
 * @param {object} [opts] - { projectPath }
 * @returns {{ task: object, knowledge_applied: object[] }}
 */
function enrichContext(task, knowledgeEntries, opts) {
  opts = opts || {};

  if (!knowledgeEntries) {
    const description = `${task.title || ''} ${task.description || ''}`;
    knowledgeEntries = getRelevantKnowledge(description, null, opts);
  }

  if (knowledgeEntries.length === 0) {
    return { task, knowledge_applied: [] };
  }

  const knowledge = require('./cross-project-knowledge');
  const knowledgeOpts = {};

  // Check policy for knowledge_path
  try {
    const { loadCrossProjectPolicy } = require('./knowledge-harvester');
    const policy = loadCrossProjectPolicy(opts.projectPath);
    if (policy.knowledge_path) {
      knowledgeOpts.knowledgePath = policy.knowledge_path;
    }
  } catch (e) { /* best effort */ }

  const applied = [];
  const enrichedTask = { ...task };

  // Group knowledge by type
  const byType = {};
  for (const entry of knowledgeEntries) {
    if (!byType[entry.type]) byType[entry.type] = [];
    byType[entry.type].push(entry);
  }

  // Apply decomposition templates
  if (byType['decomposition-templates']) {
    enrichedTask._cross_project_templates = byType['decomposition-templates'].map(e => ({
      task_type: e.content.task_type,
      template: e.content.template,
      success_rate: e.content.success_rate,
      avg_subtasks: e.content.avg_subtasks
    }));
    for (const e of byType['decomposition-templates']) {
      knowledge.recordUsage(e.id, knowledgeOpts);
      applied.push({ id: e.id, type: e.type });
    }
  }

  // Apply failure modes
  if (byType['failure-modes']) {
    enrichedTask._cross_project_failure_modes = byType['failure-modes'].map(e => ({
      event_type: e.content.event_type,
      level: e.content.level,
      resolution: e.content.resolution
    }));
    for (const e of byType['failure-modes']) {
      knowledge.recordUsage(e.id, knowledgeOpts);
      applied.push({ id: e.id, type: e.type });
    }
  }

  // Apply tech decisions
  if (byType['tech-decisions']) {
    enrichedTask._cross_project_decisions = byType['tech-decisions'].map(e => ({
      decision: e.content.decision,
      reason: e.content.reason,
      alternatives: e.content.alternatives
    }));
    for (const e of byType['tech-decisions']) {
      knowledge.recordUsage(e.id, knowledgeOpts);
      applied.push({ id: e.id, type: e.type });
    }
  }

  // Apply cost benchmarks
  if (byType['cost-benchmarks']) {
    enrichedTask._cross_project_cost_benchmarks = byType['cost-benchmarks'].map(e => ({
      task_type: e.content.task_type,
      total_tokens: e.content.total_tokens,
      cost_usd: e.content.cost_usd
    }));
    for (const e of byType['cost-benchmarks']) {
      knowledge.recordUsage(e.id, knowledgeOpts);
      applied.push({ id: e.id, type: e.type });
    }
  }

  return { task: enrichedTask, knowledge_applied: applied };
}

/**
 * Record that a knowledge entry was used in context.
 * Updates usage_count in the global knowledge base.
 *
 * @param {string} knowledgeId - Entry ID
 * @param {object} [opts] - { projectPath }
 */
function recordKnowledgeUsage(knowledgeId, opts) {
  opts = opts || {};

  try {
    const { loadCrossProjectPolicy } = require('./knowledge-harvester');
    const policy = loadCrossProjectPolicy(opts.projectPath);

    const knowledge = require('./cross-project-knowledge');
    knowledge.recordUsage(knowledgeId, {
      knowledgePath: policy.knowledge_path || undefined
    });
  } catch (e) {
    // best effort
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  getRelevantKnowledge,
  enrichContext,
  recordKnowledgeUsage
};
