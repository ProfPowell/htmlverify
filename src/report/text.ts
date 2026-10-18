import type { AssemblyResult } from '../assemble/assemble.ts';
import type { ComponentCheck, ComponentDetails, ComponentSummary, RegistryCheck } from '../assemble/lifecycle.ts';
import type { ParamSpec } from '../assemble/params.ts';
import { unifiedDiff } from '../fix/diff.ts';
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
  out.push(...table(result.plan.findings, [], '  '));
  const file = result.report?.files[0];
  if (file) {
    out.push(file.path);
    out.push(...table(file.findings, file.reviews, '  '));
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

/** Findings and review items as aligned rows, each output finding tagged with its origin. */
function table(findings: readonly Finding[], reviews: FileReport['reviews'], indent: string): string[] {
  const rows = [
    ...findings.map((f) => ({ pos: `${f.line}:${f.column}`, severity: f.severity as string, rule: f.rule, message: f.message + origin(f) })),
    ...reviews.map((r) => ({ pos: `${r.line}:${r.column}`, severity: 'review', rule: r.rule, message: r.ask })),
  ];
  const posWidth = Math.max(0, ...rows.map((r) => r.pos.length));
  const ruleWidth = Math.max(0, ...rows.map((r) => r.rule.length));
  return rows.map((r) => `${indent}${r.pos.padEnd(posWidth)}  ${r.severity.padEnd(7)}  ${r.rule.padEnd(ruleWidth)}  ${r.message}`);
}

/**
 * A component check (spec §9.10): problems with its files, then each
 * fixture's findings and how its output compares with the expected file,
 * then the coverage goals still unmet, and what to do next.
 */
export function formatComponentCheck(c: ComponentCheck): string {
  const out = [`${c.id}${c.version ? `@${c.version}` : ''}`];
  for (const p of c.problems) out.push(`  ${p.file}: ${p.message}`);
  for (const f of c.fixtures) {
    const html = `fixtures/${f.name}.html`;
    out.push(`  fixtures/${f.name}.json`);
    out.push(...table(f.result.plan.findings, [], '    '));
    // Positions in the output; info findings only confirm the house style.
    const output = [...(f.result.report?.files[0]?.findings ?? []), ...f.nu].filter((x) => x.severity !== 'info');
    if (output.length) out.push('    output:', ...table(output, [], '      '));
    if (f.result.status !== 'pass') out.push(`    ✗ ${f.result.report ? 'the output fails strict' : 'doesn’t assemble'}`);
    else if (f.expected === null) out.push(`    ✗ ${html} is missing; run component check --update to write it, then review it`);
    else if (!f.matches) out.push(`    ✗ the output differs from ${html}; if the change is intended, run component check --update and review the diff`, ...unifiedDiff(html, f.expected, f.result.html!).trimEnd().split('\n').map((l) => `      ${l}`));
    else out.push(`    ✓ ${c.written.includes(html) ? `wrote ${html}; review it` : `matches ${html}`}`);
  }
  if (c.coverage.length) {
    const unmet = c.coverage.filter((g) => !g.met);
    out.push(`  coverage: ${c.coverage.length - unmet.length} of ${c.coverage.length} goals met${unmet.length ? '; add fixtures for' : ''}`);
    for (const g of unmet) out.push(`    ✗ ${g.goal}`);
  }
  if (c.nuSkipped) out.push(`  Nu didn’t run: ${c.nuSkipped}`);
  const next = c.status !== 'pass' ? '' : c.reviewStatus === 'reviewed' ? ` · reviewed by ${c.review!.by} on ${c.review!.date}` : ` · ${c.reviewStatus}: approve it with htmlverify component approve ${c.id} --by <name>`;
  out.push(`${MARK[c.status]} ${c.status}${c.status === 'pass' ? next : ` · ${reasons(c).join(', ')}`}`, '');
  return out.join('\n');
}

/** Why a component check failed, briefly. */
function reasons(c: ComponentCheck): string[] {
  const out: string[] = [];
  if (c.problems.length) out.push(plural(c.problems.length, 'file problem'));
  const failing = c.fixtures.filter((f) => f.result.status !== 'pass' || f.nu.some((n) => n.severity === 'error')).length;
  if (failing) out.push(`${plural(failing, 'fixture')} failing`);
  const unmatched = c.fixtures.filter((f) => f.result.status === 'pass' && !f.matches).length;
  if (unmatched) out.push(`${plural(unmatched, 'expected output')} missing or different`);
  const unmet = c.coverage.filter((g) => !g.met).length;
  if (unmet) out.push(`${plural(unmet, 'coverage goal')} unmet`);
  return out;
}

/** The registry check: one line per component, then the totals. */
export function formatRegistryCheck(r: RegistryCheck): string {
  const width = Math.max(0, ...r.components.map((c) => `${c.id}${c.version ? `@${c.version}` : ''}`.length));
  const out = r.components.map((c) => {
    const name = `${c.id}${c.version ? `@${c.version}` : ''}`.padEnd(width);
    if (c.status !== 'pass') return `${name}  ✗ ${reasons(c).join(', ')}; see htmlverify component check ${c.id}`;
    if (c.reviewStatus === 'reviewed') return `${name}  ✓ reviewed by ${c.review!.by} on ${c.review!.date}`;
    return `${name}  ✗ ${c.reviewStatus === 'stale' ? `changed since ${c.review!.by} approved it on ${c.review!.date}` : 'not approved'}; its check passes, so it can be approved`;
  });
  const approved = r.components.filter((c) => c.status === 'pass' && c.reviewStatus === 'reviewed').length;
  out.push(`${MARK[r.status]} ${r.status} · ${plural(r.components.length, 'component')} · ${approved} approved`, '');
  return out.join('\n');
}

/** The catalog (spec §10.1): one line per component. */
export function formatCatalog(list: readonly ComponentSummary[]): string {
  return list.length ? `${list.map((c) => c.line).join('\n')}\n` : 'No components match.\n';
}

/** `component show`: the contract in full, and an example of its use. */
export function formatComponent(d: ComponentDetails): string {
  const c = d.contract;
  const out = [
    `${c.id}@${c.version} · ${d.summary.status} · context ${c.context}${c.budget ? ` · budget ${plural(c.budget.elements, 'element')}` : ''}`,
    c.summary,
    `Use: ${c.use}`,
  ];
  const params = Object.entries(c.params);
  out.push('', params.length ? 'data:' : 'data: none');
  const width = Math.max(0, ...params.map(([n]) => n.length));
  for (const [name, spec] of params) out.push(`  ${name.padEnd(width)}  ${paramLine(spec)}`);
  const slots = Object.entries(c.slots);
  out.push(slots.length ? 'slots:' : 'slots: none');
  for (const [name, s] of slots) {
    const count = s.max === null ? (s.min ? `at least ${s.min}` : 'any number') : s.min === s.max ? `exactly ${s.min}` : `${s.min} to ${s.max}`;
    out.push(`  ${name}  ${count}${s.accepts ? `, of ${s.accepts.join(', ')}` : ''}${s.description ? ` · ${s.description}` : ''}`);
  }
  for (const o of c.obligations) out.push(`obligation: ${o}`);
  if (d.example) {
    out.push('', `Example (fixtures/${d.example.fixture}.json):`, JSON.stringify(d.example.instance));
    if (d.example.html !== null) out.push('', 'Renders:', d.example.html.trimEnd());
  }
  out.push('');
  return out.join('\n');
}

function paramLine(spec: ParamSpec): string {
  const parts: string[] = [spec.type === 'enum' ? `enum ${spec.values!.join('|')}` : spec.type];
  if (spec.type === 'list') parts[0] = `list of ${typeof spec.items === 'object' ? `{ ${Object.entries(spec.items).map(([n, s]) => `${n}${s.required ? '' : '?'}: ${s.type === 'enum' ? s.values!.join('|') : s.type}`).join(', ')} }` : spec.items}`;
  if (spec.type === 'ref' && spec.accepts) parts[0] = `ref to ${spec.accepts.join(' or ')}`;
  parts.push(spec.default !== undefined ? `default ${JSON.stringify(spec.default)}` : spec.required ? 'required' : 'optional');
  if (spec.minLength !== undefined) parts.push(`minLength ${spec.minLength}`);
  if (spec.maxLength !== undefined) parts.push(`maxLength ${spec.maxLength}`);
  if (spec.pattern !== undefined) parts.push(`pattern ${spec.pattern}`);
  if (spec.min !== undefined) parts.push(`min ${spec.min}`);
  if (spec.max !== undefined) parts.push(`max ${spec.max}`);
  if (spec.minItems !== undefined) parts.push(`minItems ${spec.minItems}`);
  if (spec.maxItems !== undefined) parts.push(`maxItems ${spec.maxItems}`);
  if (spec.description) parts.push(spec.description);
  return parts.join(' · ');
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
