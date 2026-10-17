import { decodeUtf8 } from '../parse/decode.ts';
import { LineIndex } from '../parse/lines.ts';
import { PARSER, parseHtml } from '../parse/parse.ts';
import { reconcile } from '../parse/reconcile.ts';
import { isElement, walk } from '../parse/tree.ts';
import { resolveProfile, type Config } from '../config.ts';
import type { Profile, ProfileName } from '../profiles.ts';
import { checkAttributes, checkBooleanValues } from '../rules/attributes.ts';
import { checkContentModel } from '../rules/content-model.ts';
import { checkDocument } from '../rules/document.ts';
import { checkIds } from '../rules/ids.ts';
import { RULE_BY_ID, RULES } from '../rules/registry.ts';
import { checkStyle } from '../rules/style.ts';
import { checkSyntax } from '../rules/syntax.ts';
import { checkA11y } from '../rules/a11y.ts';
import { checkBloat, type Metrics } from '../rules/bloat.ts';
import { checkComponents } from '../rules/component.ts';
import { checkPolicy } from '../rules/policy.ts';
import { checkSemantic } from '../rules/semantic.ts';
import type { Authority, Edit, RawFinding, RawReview, RuleContext, Severity } from '../rules/types.ts';
import { VERSION } from '../version.ts';
import { loadSnapshot, Vocabulary } from '../vocab/vocabulary.ts';
import { runNu, type NuMessage, type NuOptions } from '../nu/nu.ts';
import { canonicalJson } from './canonical.ts';

export interface CheckInput {
  /** Relative POSIX path shown in reports. */
  path: string;
  source: Uint8Array | string;
  /** Context element name; makes the input a fragment. */
  context?: string | null;
}

export interface CheckOptions {
  /** The built-in profile; defaults to the config's `extends`, then strict. */
  profile?: ProfileName;
  /** A validated htmlverify.config.json (see parseConfig). */
  config?: Config | null;
  /** Cross-check documents with the Nu Html Checker (spec §6.9). */
  nu?: NuOptions | null;
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
  /** Rules of later families that reported the same defect here (spec §5.1). */
  alsoReportedBy?: string[];
  /** Other places the defect shows, such as where the parser closed the element. */
  alsoAt?: { line: number; column: number }[];
  /** Other checkers' messages about this spot, such as Nu's (spec §6.9). */
  related?: { source: string; message: string; line: number; column: number }[];
}

/** A judgment left to a person; never counted as a pass or a failure (spec §5.2). */
export interface Review {
  /** Other checkers' messages about this spot, such as Nu's (spec §6.9). */
  related?: Finding['related'];
  rule: string;
  line: number;
  column: number;
  offset: number;
  endOffset: number;
  ask: string;
}

export type Status = 'pass' | 'fail' | 'incomplete';

export interface FileReport {
  path: string;
  kind: 'document' | 'fragment';
  sha256: string;
  status: Status;
  summary: { errors: number; warnings: number; infos: number; reviews: number };
  findings: Finding[];
  reviews: Review[];
  /** Structural metrics (spec §6.8), reported whether or not a bloat threshold is crossed. */
  metrics: Metrics | null;
  coverage: { untested: { check: string; reason: string }[] };
  score: { overall: number | null; dimensions: Record<string, number | null> };
}

export interface Report {
  /** `nu` is the Nu Html Checker's version when the cross-check ran. */
  tool: { name: 'htmlverify'; version: string; parser: string; nu?: string };
  profile: { name: ProfileName; hash: string };
  status: Status;
  files: FileReport[];
}

export const LIMITS = { bytes: 5 * 1024 * 1024, elements: 100_000, depth: 512 } as const;

const DIMENSIONS = [
  { id: 'syntax-style', weight: 20, families: ['syntax', 'style'] },
  { id: 'content-component', weight: 25, families: ['content', 'component', 'conformance'] },
  { id: 'a11y', weight: 25, families: ['a11y'] },
  { id: 'semantic-policy', weight: 20, families: ['semantic', 'policy'] },
  { id: 'bloat', weight: 10, families: ['bloat'] },
] as const;

const PENALTY: Record<Severity, number> = { error: 10, warning: 3, info: 0 };

export async function check(inputs: CheckInput | CheckInput[], options: CheckOptions = {}): Promise<Report> {
  const profile = resolveProfile(options.profile, options.config ?? null);
  const vocabulary = new Vocabulary(profile.vocabularies, profile.elements, profile.options.adHocPrefix);
  const list = Array.isArray(inputs) ? inputs : [inputs];
  // One Nu run covers every document; fragments aren't Nu's to check.
  const documents = list.map((input, i) => ({ input, i })).filter(({ input }) => !input.context);
  const nu = options.nu
    ? await runNu(documents.map(({ input }) => (typeof input.source === 'string' ? new TextEncoder().encode(input.source) : input.source)), options.nu)
    : null;
  const nuFor = new Map(documents.map(({ i }, n) => [i, nu?.messages[n] ?? []]));
  const files: FileReport[] = [];
  for (const [i, input] of list.entries()) {
    const cross = nu ? { version: nu.version, messages: nuFor.get(i) ?? null, unavailable: nu.unavailable } : null;
    files.push(await checkFile(input, profile, vocabulary, cross));
  }
  const status: Status = files.some((f) => f.status === 'incomplete') ? 'incomplete' : files.some((f) => f.status === 'fail') ? 'fail' : 'pass';
  // A snapshot regenerated under the same version still changes the hash.
  const snapshots = profile.vocabularies.map((id) => loadSnapshot(id).source.sha256);
  return {
    tool: { name: 'htmlverify', version: VERSION, parser: PARSER, ...(nu?.version ? { nu: nu.version } : {}) },
    profile: { name: profile.name, hash: await sha256(new TextEncoder().encode(canonicalJson({ ...profile, snapshots, version: VERSION }))) },
    status,
    files,
  };
}

/** Nu's messages for one input: null for a fragment; `unavailable` when Nu couldn't run. */
interface NuCross {
  version: string | null;
  messages: NuMessage[] | null;
  unavailable: string | null;
}

async function checkFile(input: CheckInput, profile: Profile, vocabulary: Vocabulary, nu: NuCross | null): Promise<FileReport> {
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
    return finish(base, [finding], [], profile, [{ check: 'every other rule', reason: 'the input isn’t valid UTF-8' }]);
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
    ruleOptions: Object.fromEntries(RULES.filter((r) => r.options).map((r) => [
      r.id,
      { ...Object.fromEntries(Object.entries(r.options!).map(([k, o]) => [k, o.default])), ...profile.ruleOptions[r.id] },
    ])),
    vocabulary,
  };
  const syntax = checkSyntax(ctx);
  const content = checkContentModel(ctx);
  const a11y = checkA11y(ctx);
  const semantic = checkSemantic(ctx);
  const bloat = checkBloat(ctx);
  const raw = [
    ...syntax.findings,
    ...checkStyle(ctx, syntax.absorbed),
    ...checkBooleanValues(ctx),
    ...checkAttributes(ctx),
    ...content.findings,
    ...checkComponents(ctx),
    ...checkIds(ctx),
    ...checkDocument(ctx),
    ...a11y.findings,
    ...semantic.findings,
    ...checkPolicy(ctx),
    ...bloat.findings,
  ];
  const enabled = raw.filter((r) => (profile.severities[r.rule] ?? 'off') !== 'off');
  const findings = dedupe(enabled).map(({ raw: r, also }) => toFinding(r, input.path, lines, profile, also));
  const reviews = [...a11y.reviews, ...semantic.reviews].filter((r) => (profile.severities[r.rule] ?? 'off') !== 'off').map((r) => toReview(r, lines));
  if (nu?.messages) findings.push(...crossCheck(findings, reviews, nu.messages, nu.version, input.path, lines, profile));
  const untested = [...profile.untested, ...content.untested];
  if (!vocabulary.configured) untested.push({ check: 'component/*', reason: 'no vocabulary is configured' });
  if (nu && nu.unavailable) untested.push({ check: 'conformance/nu', reason: nu.unavailable });
  else if (nu && !nu.messages) untested.push({ check: 'conformance/nu', reason: 'Nu checks only documents' });
  if (kind === 'fragment') {
    untested.push({ check: 'syntax/doctype, syntax/encoding (charset declaration), a11y/lang, a11y/title, first-heading check', reason: 'fragments have no document' });
  }
  return finish(base, findings, reviews, profile, untested, bloat.metrics);
}

/** Families whose findings Nu's messages can corroborate. */
const CONFORMANCE = new Set(['syntax', 'content', 'component', 'a11y']);

/**
 * Nu's messages (spec §6.9): one on the same line as a local conformance
 * finding becomes that finding's related evidence; the rest are
 * conformance/nu findings, verbatim, with Nu's severity.
 */
export function crossCheck(findings: Finding[], reviews: Review[], messages: NuMessage[], version: string | null, path: string, lines: LineIndex, profile: Profile): Finding[] {
  const configured = profile.severities['conformance/nu'] ?? 'off';
  const source = version ? `nu@${version.split(' ')[0]}` : 'nu';
  const out: Finding[] = [];
  for (const m of messages) {
    if (disagreement(m, profile)) continue;
    // A document-level message matches the local finding wherever each checker puts it; otherwise, the
    // finding nearest Nu's column on a shared line, at its span or one of its other places, preferring
    // conformance families.
    const documentLevel = DOCUMENT_LEVEL.find(([pattern]) => pattern.test(m.message))?.[1];
    const local = documentLevel
      ? findings.find((f) => documentLevel.includes(f.rule))
      : findings
        .flatMap((f) => { const d = distance(f, m); return d === null ? [] : [{ f, d }]; })
        .sort((a, b) => a.d - b.d || Number(!CONFORMANCE.has(a.f.rule.split('/')[0]!)) - Number(!CONFORMANCE.has(b.f.rule.split('/')[0]!)))[0]?.f;
    // A judgment left to a person, such as an article without a heading, covers Nu's warning about it,
    // but never an error.
    const asked = local || m.severity === 'error' ? null : reviews.find((r) => m.line <= r.line && r.line <= m.endLine);
    const target = local ?? asked;
    if (target) {
      (target.related ??= []).push({ source, message: m.message, line: m.line, column: m.column });
      continue;
    }
    if (configured === 'off') continue;
    const offset = lines.offset(m.line, m.column);
    out.push({
      rule: 'conformance/nu',
      severity: configured === 'error' ? m.severity : configured,
      authority: 'standard',
      message: m.message,
      path,
      line: m.line,
      column: m.column,
      endLine: m.line,
      endColumn: m.column,
      offset,
      endOffset: offset,
      evidence: { checker: source },
      fix: null,
      origin: null,
    });
  }
  return out;
}

/**
 * Columns between a Nu message and the nearest of a finding's span and other
 * places that share a line with it; 0 inside the span, null when none does.
 */
function distance(f: Finding, m: NuMessage): number | null {
  const spans = [f, ...(f.alsoAt ?? []).map((p) => ({ ...p, endLine: p.line, endColumn: p.column }))];
  let best: number | null = null;
  for (const s of spans) {
    if (s.line > m.endLine || m.line > s.endLine) continue;
    const from = s.line === m.line ? s.column : 1;
    const to = s.endLine === m.line ? s.endColumn : Infinity;
    const d = m.line !== s.line && m.line !== s.endLine ? 0 : m.column < from ? from - m.column : m.column > to ? m.column - to : 0;
    if (best === null || d < best) best = d;
  }
  return best;
}

/** Nu's messages about the whole document, and the local rules that report the same thing at the top. */
const DOCUMENT_LEVEL: readonly [RegExp, readonly string[]][] = [
  [/without seeing a doctype first|Non-space characters found without seeing a doctype/, ['syntax/doctype']],
  [/“lang” attribute to the “html” start tag/, ['a11y/lang']],
  [/required instance of child element “title”/, ['content/order', 'a11y/title']],
  [/^End of file seen/, ['syntax/unclosed-element', 'syntax/self-closing-non-void', 'syntax/misnested']],
];

/**
 * Nu messages htmlverify disagrees with by design: the trailing slash the
 * house void form asks for, CSS (which htmlverify leaves to CSS tools, and
 * where Nu's checker lags current CSS), and Nu's claim that attributes are
 * "never allowed" on autonomous custom elements, which HTML allows.
 */
function disagreement(m: NuMessage, profile: Profile): boolean {
  if (/^Trailing slash on void elements/.test(m.message)) return profile.options.voidElements !== 'html';
  if (/^CSS: |^Style rule “.*” not allowed outside/.test(m.message)) return true;
  return m.severity === 'info' && /^The “[^”]+” attribute is never allowed on the “[a-z][^”]*-[^”]*” element\.$/.test(m.message);
}

/** Family order for deduplication: the earliest family keeps the finding (spec §5.1). */
const FAMILY_ORDER = ['syntax', 'content', 'component', 'a11y', 'semantic', 'policy', 'style', 'bloat'];
const familyRank = (rule: string) => FAMILY_ORDER.indexOf(rule.split('/')[0]!);

/** Merges findings that name the same defect at the same location. */
function dedupe(raw: RawFinding[]): { raw: RawFinding; also: string[] }[] {
  const groups = new Map<string, RawFinding[]>();
  const out: { raw: RawFinding; also: string[] }[] = [];
  for (const r of raw) {
    if (!r.defect) {
      out.push({ raw: r, also: [] });
      continue;
    }
    const key = `${r.defect}\0${r.offset}\0${r.endOffset}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => familyRank(a.rule) - familyRank(b.rule) || cmp(a.rule, b.rule));
    out.push({ raw: group[0]!, also: [...new Set(group.slice(1).map((g) => g.rule))].filter((r) => r !== group[0]!.rule) });
  }
  return out;
}

function toReview(raw: RawReview, lines: LineIndex): Review {
  const start = lines.position(raw.offset);
  return { rule: raw.rule, line: start.line, column: start.column, offset: raw.offset, endOffset: raw.endOffset, ask: raw.ask };
}

function toFinding(raw: RawFinding, path: string, lines: LineIndex, profile: Profile, also: string[]): Finding {
  const configured = profile.severities[raw.rule] ?? 'off';
  const meta = RULE_BY_ID.get(raw.rule);
  if (!meta) throw new Error(`unregistered rule ${raw.rule}`);
  const start = lines.position(raw.offset);
  const end = lines.position(raw.endOffset);
  return {
    rule: raw.rule,
    severity: raw.severity ?? (configured === 'off' ? 'error' : configured),
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
    ...(also.length ? { alsoReportedBy: also } : {}),
    ...(raw.alsoAt?.length ? { alsoAt: raw.alsoAt.map((o) => { const p = lines.position(o); return { line: p.line, column: p.column }; }) } : {}),
  };
}

type Base = Pick<FileReport, 'path' | 'kind' | 'sha256'>;

function finish(base: Base, findings: Finding[], reviews: Review[], profile: Profile, untested: FileReport['coverage']['untested'], metrics: Metrics | null = null): FileReport {
  findings.sort((a, b) => a.offset - b.offset || cmp(a.rule, b.rule) || a.endOffset - b.endOffset || cmp(a.message, b.message));
  reviews.sort((a, b) => a.offset - b.offset || cmp(a.rule, b.rule) || cmp(a.ask, b.ask));
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const summary = { errors: count('error'), warnings: count('warning'), infos: count('info'), reviews: reviews.length };
  return {
    ...base,
    status: summary.errors > 0 || (profile.maxWarnings !== null && summary.warnings > profile.maxWarnings) ? 'fail' : 'pass',
    summary,
    findings,
    reviews,
    metrics,
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
    metrics: null,
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
