/**
 * Auto-Refactor on Detection — Phase 8.10 (Pilot AGI-953a)
 *
 * Generates refactoring plans when quality issues are detected:
 * - Duplicate consolidation
 * - Dead code removal
 * - Naming inconsistency fixes
 *
 * All refactoring goes through plan approval (configurable auto-approve for low-risk).
 */

const fs = require('fs');
const path = require('path');

const PLANS_DIR = '.claude/pilot/state/refactor-plans';
const RISK_LEVELS = ['low', 'medium', 'high'];

// =============================================================================
// PLAN GENERATION
// =============================================================================

/**
 * Generate a refactoring plan from detected issues.
 *
 * @param {object} detection - Output from duplicate-detector or dead-code-detector
 * @param {object} opts - { type, filePath, projectRoot? }
 * @returns {{ plan_id, steps, risk_level, auto_approvable }}
 */
function generatePlan(detection, opts) {
  if (!detection || !opts || !opts.type) {
    return { error: 'detection and opts.type required' };
  }

  const planId = generatePlanId();
  const steps = [];
  let riskLevel = 'low';

  switch (opts.type) {
    case 'duplicate':
      riskLevel = planDuplicateConsolidation(detection, steps, opts);
      break;
    case 'dead_code':
      riskLevel = planDeadCodeRemoval(detection, steps, opts);
      break;
    case 'naming':
      riskLevel = planNamingFix(detection, steps, opts);
      break;
    default:
      return { error: `unknown refactor type: ${opts.type}` };
  }

  const plan = {
    plan_id: planId,
    type: opts.type,
    file_path: opts.filePath || null,
    steps,
    risk_level: riskLevel,
    auto_approvable: riskLevel === 'low',
    created_at: new Date().toISOString(),
    status: 'pending'
  };

  savePlan(plan);
  return plan;
}

// =============================================================================
// DUPLICATE CONSOLIDATION PLAN
// =============================================================================

function planDuplicateConsolidation(detection, steps, opts) {
  const { duplicates, reexports, wrappers } = detection;
  let risk = 'low';

  // Handle duplicate functions
  if (duplicates && duplicates.length > 0) {
    for (const dup of duplicates) {
      const bestMatch = dup.matches[0];
      steps.push({
        action: 'consolidate_function',
        description: `Replace duplicate "${dup.function_name}" with existing "${bestMatch.name}" from ${bestMatch.file_path}:${bestMatch.line}`,
        source_file: opts.filePath,
        target_file: bestMatch.file_path,
        function_name: dup.function_name,
        replace_with: bestMatch.name,
        confidence: bestMatch.confidence
      });

      // If exported, need to update imports across codebase
      if (bestMatch.confidence >= 0.9) {
        steps.push({
          action: 'update_imports',
          description: `Update imports from "${opts.filePath}" to use "${bestMatch.file_path}" instead`,
          old_import: opts.filePath,
          new_import: bestMatch.file_path,
          symbol: dup.function_name
        });
      }
    }
    if (duplicates.length > 2) risk = 'medium';
  }

  // Handle unnecessary wrappers
  if (wrappers && wrappers.length > 0) {
    for (const wrapper of wrappers) {
      steps.push({
        action: 'remove_wrapper',
        description: `Remove wrapper "${wrapper.wrapper_name}" — just calls "${wrapper.calls}" with same args`,
        file_path: wrapper.file_path,
        wrapper_name: wrapper.wrapper_name,
        calls: wrapper.calls,
        line: wrapper.line
      });
    }
  }

  // Handle unnecessary re-exports
  if (reexports && reexports.length > 0) {
    for (const reexport of reexports) {
      steps.push({
        action: 'remove_reexport',
        description: `Remove re-export of [${reexport.names.join(', ')}] from "${reexport.source}" — import directly instead`,
        file_path: reexport.file_path,
        names: reexport.names,
        source: reexport.source,
        line: reexport.line
      });
    }
  }

  return risk;
}

// =============================================================================
// DEAD CODE REMOVAL PLAN
// =============================================================================

function planDeadCodeRemoval(detection, steps, opts) {
  let risk = 'low';

  // Unused exports
  if (detection.unused_exports && detection.unused_exports.length > 0) {
    for (const exp of detection.unused_exports) {
      steps.push({
        action: 'remove_export',
        description: `Remove unused export "${exp.name}" (${exp.type}) at line ${exp.line}`,
        file_path: opts.filePath,
        export_name: exp.name,
        line: exp.line
      });
    }
    if (detection.unused_exports.length > 3) risk = 'medium';
  }

  // Backward compat shims
  if (detection.backward_compat && detection.backward_compat.length > 0) {
    for (const bc of detection.backward_compat) {
      steps.push({
        action: 'remove_compat',
        description: `Remove ${bc.type}: ${bc.description}`,
        file_path: opts.filePath,
        line: bc.line,
        compat_type: bc.type
      });
    }
  }

  // Stale TODOs
  if (detection.todos) {
    const stale = detection.todos.filter(t => t.stale);
    if (stale.length > 0) {
      steps.push({
        action: 'resolve_todos',
        description: `Resolve ${stale.length} stale TODO/FIXME comments`,
        file_path: opts.filePath,
        todos: stale.map(t => ({ line: t.line, text: t.text, type: t.type }))
      });
    }
  }

  return risk;
}

// =============================================================================
// NAMING FIX PLAN
// =============================================================================

function planNamingFix(detection, steps, opts) {
  let risk = 'medium'; // Renaming across files is always at least medium risk

  if (detection.inconsistencies && detection.inconsistencies.length > 0) {
    for (const inc of detection.inconsistencies) {
      steps.push({
        action: 'rename_across_layers',
        description: `Rename "${inc.current_name}" to "${inc.canonical_name}" in ${inc.domain} (${inc.file_path})`,
        file_path: inc.file_path,
        current_name: inc.current_name,
        canonical_name: inc.canonical_name,
        domain: inc.domain,
        affects_layers: inc.affects_layers || []
      });
    }

    if (detection.inconsistencies.length > 5) risk = 'high';
  }

  return risk;
}

// =============================================================================
// PLAN EXECUTION TRACKING
// =============================================================================

/**
 * Mark a plan step as completed.
 */
function completeStep(planId, stepIndex, result) {
  const plan = loadPlan(planId);
  if (!plan) return { success: false, error: 'plan not found' };
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    return { success: false, error: 'invalid step index' };
  }

  plan.steps[stepIndex].completed = true;
  plan.steps[stepIndex].completed_at = new Date().toISOString();
  plan.steps[stepIndex].result = result || 'success';

  // Check if all steps are done
  const allDone = plan.steps.every(s => s.completed);
  if (allDone) {
    plan.status = 'completed';
    plan.completed_at = new Date().toISOString();
  }

  savePlan(plan);
  return { success: true, all_done: allDone };
}

/**
 * Approve a plan for execution.
 */
function approvePlan(planId, approver) {
  const plan = loadPlan(planId);
  if (!plan) return { success: false, error: 'plan not found' };

  plan.status = 'approved';
  plan.approved_at = new Date().toISOString();
  plan.approved_by = approver || 'auto';

  savePlan(plan);
  return { success: true };
}

/**
 * Get the next pending step in a plan.
 */
function getNextStep(planId) {
  const plan = loadPlan(planId);
  if (!plan) return null;
  if (plan.status !== 'approved' && plan.status !== 'in_progress') return null;

  for (let i = 0; i < plan.steps.length; i++) {
    if (!plan.steps[i].completed) {
      return { index: i, step: plan.steps[i] };
    }
  }
  return null;
}

// =============================================================================
// PLAN STORAGE
// =============================================================================

function getPlansDir() {
  return path.join(process.cwd(), PLANS_DIR);
}

function savePlan(plan) {
  const dir = getPlansDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${plan.plan_id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf8');
}

function loadPlan(planId) {
  if (!planId) return null;
  const filePath = path.join(getPlansDir(), `${planId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function listPlans(opts) {
  opts = opts || {};
  const dir = getPlansDir();
  if (!fs.existsSync(dir)) return [];

  const plans = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (opts.status && plan.status !== opts.status) continue;
      plans.push(plan);
    } catch (e) { /* skip invalid */ }
  }

  return plans.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

let _planSeq = 0;

function generatePlanId() {
  const ts = Date.now().toString(36);
  const seq = (_planSeq++).toString(36);
  return `R-${ts}-${seq}`;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Plan generation
  generatePlan,

  // Plan execution
  completeStep,
  approvePlan,
  getNextStep,

  // Plan storage
  savePlan,
  loadPlan,
  listPlans,

  // Constants
  RISK_LEVELS
};
