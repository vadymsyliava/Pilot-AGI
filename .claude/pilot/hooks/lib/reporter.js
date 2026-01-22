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

module.exports = { format, formatConsole, formatMetricsJSON };
