#!/usr/bin/env node

/**
 * Pilot AGI Pre-Tool-Use Hook
 *
 * Runs before Edit and Write tool calls to enforce governance rules.
 *
 * Enforcement rules (from policy.yaml):
 * - R1: require_active_task - Must have in_progress bd task
 * - R2: require_plan_approval - Must have approved plan
 * - R3: protected_branches - Cannot edit on main/master/production
 * - R4: never_edit - Certain files are always blocked
 *
 * Exceptions:
 * - no_task_required: Some files don't need active task
 * - no_plan_required: Some files don't need plan approval
 *
 * Security note: All execSync calls use hardcoded commands only.
 * No user input is ever interpolated into shell commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadPolicy, isException, matchesPattern } = require('./lib/policy');

const APPROVED_PLANS_DIR = '.claude/pilot/state/approved-plans';

// =============================================================================
// CONTEXT HELPERS
// =============================================================================

/**
 * Get active bd task (in_progress status)
 * Security: Command string is a compile-time constant with no user input.
 */
function getActiveTask() {
  if (!fs.existsSync(path.join(process.cwd(), '.beads'))) return null;

  try {
    // Security: This is a hardcoded constant command string.
    // No user-supplied data is interpolated into this command.
    const result = execSync('bd list --status in_progress --json 2>/dev/null || echo "[]"', {
      encoding: 'utf8',
      timeout: 5000
    });
    const tasks = JSON.parse(result);
    if (tasks.length > 0) {
      return {
        id: tasks[0].id,
        title: tasks[0].title
      };
    }
  } catch (e) {
    // bd not available or error
  }

  return null;
}

/**
 * Get current git branch
 * Security: Command string is a compile-time constant with no user input.
 */
function getCurrentBranch() {
  try {
    // Security: This is a hardcoded constant command string.
    // No user-supplied data is interpolated into this command.
    const branch = execSync('git branch --show-current 2>/dev/null || echo ""', {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
    return branch || null;
  } catch (e) {
    return null;
  }
}

/**
 * Check if a plan is approved for the given task
 */
function isPlanApproved(taskId) {
  if (!taskId) return false;

  const approvalFile = path.join(process.cwd(), APPROVED_PLANS_DIR, `${taskId}.json`);

  if (!fs.existsSync(approvalFile)) {
    return false;
  }

  try {
    const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    return approval.approved === true;
  } catch (e) {
    return false;
  }
}

/**
 * Make a file path relative to cwd for pattern matching
 */
function toRelativePath(filePath) {
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) {
    return filePath.slice(cwd.length + 1); // +1 for the slash
  }
  return filePath;
}

// =============================================================================
// ENFORCEMENT CHECKS
// =============================================================================

/**
 * Check all enforcement rules
 * Returns { allowed: boolean, reason: string }
 */
function checkEnforcement(filePath, policy) {
  const relativePath = toRelativePath(filePath);

  // R4: never_edit check - these are always blocked
  if (matchesPattern(relativePath, policy.exceptions?.never_edit)) {
    return {
      allowed: false,
      reason: `Protected file: ${relativePath} cannot be edited (security policy)`
    };
  }

  // R3: protected_branches check
  const branch = getCurrentBranch();
  const protectedBranches = policy.enforcement?.protected_branches || [];
  if (branch && protectedBranches.includes(branch)) {
    // Check if it's an exception file
    if (!isException(relativePath, 'no_task_required', policy)) {
      return {
        allowed: false,
        reason: `Protected branch: Cannot edit files on '${branch}'. Create a feature branch first.`
      };
    }
  }

  // R1: require_active_task check
  if (policy.enforcement?.require_active_task) {
    // Check exception first
    if (!matchesPattern(relativePath, policy.exceptions?.no_task_required)) {
      const activeTask = getActiveTask();
      if (!activeTask) {
        return {
          allowed: false,
          reason: `No active task. Start a task with /pilot-next before editing files.\n\nTo edit: ${relativePath}`
        };
      }

      // R2: require_plan_approval check (only if task exists)
      if (policy.enforcement?.require_plan_approval) {
        // Check exception
        if (!matchesPattern(relativePath, policy.exceptions?.no_plan_required)) {
          if (!isPlanApproved(activeTask.id)) {
            return {
              allowed: false,
              reason: `Plan not approved. Create and approve a plan with /pilot-plan first.\n\nTask: [${activeTask.id}] ${activeTask.title}\nFile: ${relativePath}`
            };
          }
        }
      }
    }
  }

  // All checks passed
  return { allowed: true, reason: null };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  // Read stdin for hook input
  let hookInput = {};
  try {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    if (inputData.trim()) {
      hookInput = JSON.parse(inputData);
    }
  } catch (e) {
    // No stdin or invalid JSON - allow through
    process.exit(0);
  }

  const toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};

  // Only handle Edit and Write tools
  if (toolName !== 'Edit' && toolName !== 'Write') {
    process.exit(0);
  }

  // Get file path from tool input
  const filePath = toolInput.file_path;
  if (!filePath) {
    process.exit(0);
  }

  // Load policy
  let policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    // No policy - allow through
    process.exit(0);
  }

  // Check enforcement rules
  const result = checkEnforcement(filePath, policy);

  if (!result.allowed) {
    // Block the edit
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // Allow the edit
  process.exit(0);
}

main().catch(() => {
  // Fail gracefully - allow through
  process.exit(0);
});
