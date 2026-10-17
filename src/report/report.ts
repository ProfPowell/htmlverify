import { decodeUtf8 } from '../parse/decode.ts';
import { LineIndex } from '../parse/lines.ts';
import { PARSER, parseHtml } from '../parse/parse.ts';
import { reconcile } from '../parse/reconcile.ts';
import { isElement, walk } from '../parse/tree.ts';
import { PROFILES, type Profile, type ProfileName } from '../profiles.ts';
import { checkBooleanValues } from '../rules/content.ts';
import { RULE_BY_ID } from '../rules/registry.ts';
import { checkStyle } from '../rules/style.ts';
import { checkSyntax } from '../rules/syntax.ts';
import type { Authority, Edit, RawFinding, RuleContext, Severity } from '../rules/types.ts';
import { VERSION } from '../version.ts';
import { canonicalJson } from './canonical.ts';

export interface CheckInput {
  /** Relative POSIX path shown in reports. */
  path: string;
  source: Uint8Array | string;
  /** Context element name; makes the input a fragment. */
  context?: string | null;
}

export interface CheckOptions {
  profile?: ProfileName;
}

export interface Finding {
  rule: string;
  severity: Severity;
  authority: Authority;
  message: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  offset: number;
  endOffset: number;
  evidence?: Record<string, string | number | boolean>;
  fix: { edits: Edit[] } | null;
  origin: null;
}

export type Status = 'pass' | 'fail' | 'incomplete';

export interface FileReport {
  path: string;
  kind: 'document' | 'fragment';
  sha256: string;
  status: Status;
  summary: { errors: number; warnings: number; infos: number; reviews: number };
  findings: Finding[];
  reviews: never[];
  coverage: { untested: { check: string; reason: string }[] };
  score: { overall: number | null; dimensions: Record<string, number | null> };
}

export interface Report {
  tool: { name: 'htmlverify'; version: string; parser: string };
  profile: { name: ProfileName; hash: string };
  status: Status;
  files: FileReport[];
}

export const LIMITS = { bytes: 5 * 1024 * 1024, elements: 100_000, depth: 512 } as const;

const DIMENSIONS = [
  { id: 'syntax-style', weight: 20, families: ['syntax', 'style'] },
  { id: 'content-component', weight: 25, families: ['content', 'component'] },
  { id: 'a11y', weight: 25, families: ['a11y'] },
  { id: 'semantic-policy', weight: 20, families: ['semantic', 'policy'] },
  { id: 'bloat', weight: 10, families: ['bloat'] },
] as const;

const PENALTY: Record<Severity, number> = { error: 10, warning: 3, info: 0 };

export async function check(inputs: CheckInput | CheckInput[], options: CheckOptions = {}): Promise<Report> {
  const profile = PROFILES[options.profile ?? 'strict'];
  const files: FileReport[] = [];
  for (const input of Array.isArray(inputs) ? inputs : [inputs]) files.push(await checkFile(input, profile));
  const status: Status = files.some((f) => f.status === 'incomplete') ? 'incomplete' : files.some((f) => f.status === 'fail') ? 'fail' : 'pass';
  return {
    tool: { name: 'htmlverify', version: VERSION, parser: PARSER },
    profile: { name: profile.name, hash: await sha256(new TextEncoder().encode(canonicalJson({ ...profile, version: VERSION }))) },
    status,
    files,
  };
}

async function checkFile(input: CheckInput, profile: Profile): Promise<FileReport> {
  const bytes = typeof input.source === 'string' ? new TextEncoder().encode(input.source) : input.source;
  const kind = input.context ? 'fragment' : 'document';
  const base = { path: input.path, kind, sha256: await sha256(bytes) } as const;

  if (bytes.length > LIMITS.bytes) return incomplete(base, `the file is larger than ${LIMITS.bytes} bytes`);

  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    const offset = decoded.prefix.length;
    const pos = new LineIndex(decoded.prefix).position(offset);
    const finding: Finding = {
      rule: 'syntax/encoding',
      severity: 'error',
      authority: 'standard',
      message: `Invalid UTF-8 at byte ${decoded.byteOffset}. Save the file as UTF-8.`,
      path: input.path,
      line: pos.line,
      column: pos.column,
      endLine: pos.line,
      endColumn: pos.column,
      offset,
      endOffset: offset,
      evidence: { byte: decoded.byteOffset },
      fix: null,
      origin: null,
    };
    return finish(base, [finding], profile, [{ check: 'every other rule', reason: 'the input isn’t valid UTF-8' }]);
  }

  const parsed = parseHtml(decoded.text, input.context ?? null);
  let elements = 0;
  let depth = 0;
  for (const entry of walk(parsed.root)) {
    if (!isElement(entry.node)) continue;
    elements++;
    depth = Math.max(depth, entry.depth);
  }
  if (elements > LIMITS.elements) return incomplete(base, `the input has more than ${LIMITS.elements} elements`);
  if (depth > LIMITS.depth) return incomplete(base, `elements nest deeper than ${LIMITS.depth}`);

  const lines = new LineIndex(decoded.text);
  const ctx: RuleContext = {
    text: decoded.text,
    bytes,
    bom: decoded.bom,
    parsed,
    signals: reconcile(parsed, decoded.text),
    lines,
    options: profile.options,
  };
  const syntax = checkSyntax(ctx);
  const raw = [...syntax.findings, ...checkStyle(ctx, syntax.absorbed), ...checkBooleanValues(ctx)];
  const findings = raw.flatMap((r) => toFinding(r, input.path, lines, profile));
  const untested = [...profile.untested];
  if (kind === 'fragment') untested.push({ check: 'syntax/doctype, syntax/encoding (charset declaration)', reason: 'fragments have no document' });
  return finish(base, findings, profile, untested);
}

function toFinding(raw: RawFinding, path: string, lines: LineIndex, profile: Profile): Finding[] {
  const configured = profile.severities[raw.rule] ?? 'off';
  if (configured === 'off') return [];
  const meta = RULE_BY_ID.get(raw.rule);
  if (!meta) throw new Error(`unregistered rule ${raw.rule}`);
  const start = lines.position(raw.offset);
  const end = lines.position(raw.endOffset);
  return [{
    rule: raw.rule,
    severity: raw.severity ?? configured,
    authority: meta.authority,
    message: raw.message,
    path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    offset: raw.offset,
    endOffset: raw.endOffset,
    ...(raw.evidence ? { evidence: raw.evidence } : {}),
    fix: raw.fix ? { edits: raw.fix } : null,
    origin: null,
  }];
}

type Base = Pick<FileReport, 'path' | 'kind' | 'sha256'>;

function finish(base: Base, findings: Finding[], profile: Profile, untested: FileReport['coverage']['untested']): FileReport {
  findings.sort((a, b) => a.offset - b.offset || cmp(a.rule, b.rule) || a.endOffset - b.endOffset || cmp(a.message, b.message));
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const summary = { errors: count('error'), warnings: count('warning'), infos: count('info'), reviews: 0 };
  return {
    ...base,
    status: summary.errors > 0 ? 'fail' : 'pass',
    summary,
    findings,
    reviews: [],
    coverage: { untested },
    score: score(findings, profile, untested),
  };
}

function incomplete(base: Base, reason: string): FileReport {
  return {
    ...base,
    status: 'incomplete',
    summary: { errors: 0, warnings: 0, infos: 0, reviews: 0 },
    findings: [],
    reviews: [],
    coverage: { untested: [{ check: 'every rule', reason }] },
    score: { overall: null, dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d.id, null])) },
  };
}

/**
 * Benchmark score (spec §5.5). Each rule adds at most its three largest
 * penalties, so padding can't dilute a defect. A dimension with an untested
 * check is null, and so is the overall score.
 */
function score(findings: Finding[], profile: Profile, untested: FileReport['coverage']['untested']): FileReport['score'] {
  const dimensions: Record<string, number | null> = {};
  for (const d of DIMENSIONS) {
    const inProfile = Object.entries(profile.severities).some(([id, s]) => s !== 'off' && d.families.some((f) => id.startsWith(`${f}/`)));
    const gap = untested.some((u) => d.families.some((f) => u.check.startsWith(`${f}/`)) || u.check.startsWith('every'));
    if (!inProfile && !gap) continue;
    if (gap) {
      dimensions[d.id] = null;
      continue;
    }
    const byRule = new Map<string, number[]>();
    for (const f of findings) {
      if (!d.families.some((fam) => f.rule.startsWith(`${fam}/`))) continue;
      byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), PENALTY[f.severity]]);
    }
    let penalty = 0;
    for (const list of byRule.values()) penalty += list.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    dimensions[d.id] = Math.max(0, 100 - penalty);
  }
  const values = DIMENSIONS.filter((d) => d.id in dimensions).map((d) => ({ weight: d.weight, value: dimensions[d.id] }));
  const overall = values.some((v) => v.value === null || v.value === undefined)
    ? null
    : Math.round(values.reduce((sum, v) => sum + v.weight * v.value!, 0) / values.reduce((sum, v) => sum + v.weight, 0));
  return { overall, dimensions };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
