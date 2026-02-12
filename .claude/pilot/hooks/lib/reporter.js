/**
 * Reporter
 *
 * Formats quality gate results for display and hook responses.
 */

/**
 * Format results into summary and details
 */
function format(results, total_duration_ms = null) {
  const passed = results.filter(r => r.status === 'pass');
  const warnings = results.filter(r => r.status === 'warn');
  const failed = results.filter(r => r.status === 'fail');
  const errors = results.filter(r => r.status === 'error');

  // Build summary line
  const parts = [];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
  if (errors.length > 0) parts.push(`${errors.length} errors`);
  if (passed.length > 0) parts.push(`${passed.length} passed`);

  let summary = `Quality gates: ${parts.join(', ')}`;
  if (total_duration_ms !== null) {
    summary += ` (${total_duration_ms}ms)`;
  }

  // Build detailed output for failures
  let details = '';
  if (failed.length > 0) {
    details += 'FAILED GATES:\n';
    for (const result of failed) {
      details += `\n[${result.gate.toUpperCase()}] ${result.message}\n`;
      if (result.details) {
        details += `${result.details}\n`;
      }
    }
  }

  // Build warnings section
  let warningsText = '';
  if (warnings.length > 0) {
    warningsText = 'WARNINGS:\n';
    for (const result of warnings) {
      warningsText += `\n[${result.gate.toUpperCase()}] ${result.message}\n`;
      if (result.details) {
        warningsText += `${result.details}\n`;
      }
    }
  }

  // Build metrics for tracking
  const metrics = {
    timestamp: new Date().toISOString(),
    total_duration_ms,
    gate_count: results.length,
    passed_count: passed.length,
    failed_count: failed.length,
    warning_count: warnings.length,
    gates: results.map(r => ({
      name: r.gate,
      status: r.status,
      duration_ms: r.duration_ms || null
    }))
  };

  return {
    summary,
    details,
    warnings: warningsText,
    passed: passed.length,
    failed: failed.length,
    total: results.length,
    metrics
  };
}

/**
 * Format for console output
 */
function formatConsole(results, total_duration_ms = null) {
  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  QUALITY GATES                                               ║',
    '╚══════════════════════════════════════════════════════════════╝',
    ''
  ];

  for (const result of results) {
    const icon = result.status === 'pass' ? '✓' :
                 result.status === 'warn' ? '⚠' :
                 result.status === 'fail' ? '✗' : '?';

    const timing = result.duration_ms ? ` (${result.duration_ms}ms)` : '';
    lines.push(`  ${icon} ${result.gate}: ${result.message}${timing}`);

    if (result.status !== 'pass' && result.details) {
      const detailLines = result.details.split('\n');
      for (const line of detailLines) {
        lines.push(`      ${line}`);
      }
    }
  }

  lines.push('');
  if (total_duration_ms !== null) {
    lines.push(`  Total: ${total_duration_ms}ms`);
  }
  lines.push('────────────────────────────────────────────────────────────────');

  return lines.join('\n');
}

/**
 * Format metrics as JSON for session logs
 */
function formatMetricsJSON(results, total_duration_ms = null) {
  return {
    timestamp: new Date().toISOString(),
    total_duration_ms,
    gates: results.map(r => ({
      name: r.gate,
      status: r.status,
      duration_ms: r.duration_ms || null,
      message: r.message
    }))
  };
}

/**
 * Format an overnight report as a console-friendly table.
 * Delegates to overnight-mode.js for the actual report generation,
 * but provides an alternative compact format for terminal display.
 *
 * @param {object} report - Report object from overnightMode.generateReport()
 * @returns {string} - Console-formatted string
 */
function formatOvernightConsole(report) {
  if (!report) return 'No report data.';

  const lines = [];
  const s = report.summary || {};
  const dur = report.duration_ms ? formatDurationCompact(report.duration_ms) : 'N/A';

  lines.push('');
  lines.push('  OVERNIGHT RUN REPORT');
  lines.push('  ' + '─'.repeat(56));
  lines.push(`  Run:        ${report.run_id}`);
  lines.push(`  Duration:   ${dur}`);
  lines.push(`  Tasks:      ${s.completed || 0}/${s.total_tasks || 0} completed (${s.success_rate || 0}%)`);
  lines.push(`  Failed:     ${s.failed || 0}`);
  lines.push(`  Errors:     ${report.total_errors || 0}`);
  lines.push(`  Tokens:     ${(report.cost?.total_tokens || 0).toLocaleString()}`);
  lines.push('  ' + '─'.repeat(56));

  if (report.tasks && report.tasks.length > 0) {
    lines.push('');
    lines.push('  TASK                        STATUS       ERRORS');
    lines.push('  ' + '─'.repeat(56));
    for (const t of report.tasks) {
      const id = (t.task_id || '').padEnd(28);
      const status = (t.status || 'unknown').padEnd(12);
      const errs = String(t.errors || 0);
      const badge = t.error_budget_exceeded ? ' !' : '';
      lines.push(`  ${id} ${status} ${errs}${badge}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function formatDurationCompact(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

module.exports = { format, formatConsole, formatMetricsJSON, formatOvernightConsole };
