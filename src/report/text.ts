import type { AssemblyResult } from '../assemble/assemble.ts';
import type { FileReport, Finding, Report } from './report.ts';

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

/**
 * An assembly (spec §9.8): the plan's findings, located in the plan, then the
 * output's, each tagged with its origin so the fix goes to the right place.
 * `written` is the file the page went to, if any.
 */
export function formatAssembly(result: AssemblyResult, written: string | null): string {
  const out: string[] = [result.plan.path];
  const table = (findings: readonly Finding[], reviews: FileReport['reviews'] = []) => {
    const rows = [
      ...findings.map((f) => ({ pos: `${f.line}:${f.column}`, severity: f.severity as string, rule: f.rule, message: f.message + origin(f) })),
      ...reviews.map((r) => ({ pos: `${r.line}:${r.column}`, severity: 'review', rule: r.rule, message: r.ask })),
    ];
    const posWidth = Math.max(0, ...rows.map((r) => r.pos.length));
    const ruleWidth = Math.max(0, ...rows.map((r) => r.rule.length));
    for (const r of rows) out.push(`  ${r.pos.padEnd(posWidth)}  ${r.severity.padEnd(7)}  ${r.rule.padEnd(ruleWidth)}  ${r.message}`);
  };
  table(result.plan.findings);
  const file = result.report?.files[0];
  if (file) {
    out.push(file.path);
    table(file.findings, file.reviews);
    out.push(summaryLine(file, result.report!.profile.name));
  }
  const errors = result.plan.findings.filter((f) => f.severity === 'error').length;
  const parts = [`${MARK[result.status]} ${result.status}`];
  if (errors) parts.push(`${plural(errors, 'error')} in the plan${file ? '' : ', so the output wasn’t checked'}`);
  parts.push(written ? `wrote ${written}` : 'wrote nothing');
  if (result.components.length) parts.push(plural(result.components.length, 'component'), plural(result.gaps.length, 'gap'));
  out.push(parts.join(' · '), '');
  return out.join('\n');
}

/** Where an output finding came from, and so what to fix: the plan, a component, or how they were put together. */
function origin(f: Finding): string {
  const o = f.origin;
  if (!o) return '';
  return `  [${o.kind}: ${o.plan} · ${o.component}${o.template ? ` ${o.template}` : ''}]`;
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
