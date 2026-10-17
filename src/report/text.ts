import type { FileReport, Report } from './report.ts';

const MARK = { pass: '✓', fail: '✗', incomplete: '!' } as const;

/** One line per finding, sized for an LLM's context window (spec §5.6). */
export function formatText(report: Report): string {
  const out: string[] = [];
  for (const file of report.files) {
    out.push(file.path);
    const rows = [
      ...file.findings.map((f) => ({
        pos: `${f.line}:${f.column}`,
        severity: f.severity as string,
        rule: f.rule,
        message: f.fix ? `${f.message}  [fix]` : f.message,
      })),
      ...file.reviews.map((r) => ({ pos: `${r.line}:${r.column}`, severity: 'review', rule: r.rule, message: r.ask })),
    ];
    const posWidth = Math.max(0, ...rows.map((r) => r.pos.length));
    const ruleWidth = Math.max(0, ...rows.map((r) => r.rule.length));
    for (const r of rows) out.push(`  ${r.pos.padEnd(posWidth)}  ${r.severity.padEnd(7)}  ${r.rule.padEnd(ruleWidth)}  ${r.message}`);
    out.push(summaryLine(file, report.profile.name), '');
  }
  if (report.files.length > 1) {
    const failed = report.files.filter((f) => f.status !== 'pass').length;
    out.push(`${MARK[report.status]} ${report.status} · ${report.files.length} files · ${failed} not passing`, '');
  }
  return out.join('\n');
}

function summaryLine(file: FileReport, profile: string): string {
  const s = file.summary;
  const parts = [
    `${MARK[file.status]} ${file.status}`,
    plural(s.errors, 'error'),
    plural(s.warnings, 'warning'),
    `${s.infos} info`,
    plural(s.reviews, 'review'),
    profile,
  ];
  const byReason = new Map<string, string[]>();
  for (const u of file.coverage.untested) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.check]);
  for (const [reason, checks] of byReason) parts.push(`untested (${reason}): ${checks.join(', ')}`);
  return parts.join(' · ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
