// The component lifecycle (spec §9.10): scaffold a component, check it
// against its fixtures with branch coverage, approve it, and check a whole
// registry, which is the CI gate. And the catalog an LLM reads before it
// writes a plan.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfile, type Config } from '../config.ts';
import type { NuOptions } from '../nu/nu.ts';
import { check, type Finding } from '../report/report.ts';
import { closest } from '../text.ts';
import { Vocabulary } from '../vocab/vocabulary.ts';
import { assemble, type AssemblyResult } from './assemble.ts';
import { COMPONENT_ID, isPage, type Contract, type Review, type SlotSpec } from './contract.ts';
import { Coverage, type CoverageGoal } from './coverage.ts';
import { jsonPointers } from './jsonpos.ts';
import { DEFAULT_SCHEMES, isObject, validateRecord, type ParamSpec, type Problem } from './params.ts';
import { KEY } from './plan.ts';
import { componentDigest, fixtureFiles, loadRegistry, type Component, type Registry, type ReviewStatus } from './registry.ts';

/** The starter registry that ships with htmlverify (spec §9.11), used when a project names none. */
export const STARTER_REGISTRY = fileURLToPath(new URL('../../registry/', import.meta.url)).replace(/[\\/]$/, '');

/** A request the registry can't serve, such as an unknown component; the CLI reports it as a usage error. */
export class LifecycleError extends Error {}

export interface LifecycleOptions {
  config?: Config | null;
  /** Also check each fixture's output with the Nu Html Checker, inside a page shell. */
  nu?: NuOptions | null;
}

/** Opens a registry with the vocabulary the config sets. */
export function openRegistry(root: string, config: Config | null = null): Registry {
  const profile = resolveProfile('strict', config);
  return loadRegistry(root, new Vocabulary(profile.vocabularies, profile.elements, profile.options.adHocPrefix));
}

export interface FixtureCheck {
  name: string;
  /** The fixture rendered: the component alone in its context, as a one-instance plan keyed by the fixture's name. */
  result: AssemblyResult;
  /** fixtures/<name>.html, or null when it's missing. */
  expected: string | null;
  matches: boolean;
  /** Nu's findings on the output inside a page shell, when Nu ran. */
  nu: Finding[];
}

export interface ComponentCheck {
  id: string;
  version: string | null;
  status: 'pass' | 'fail';
  /** Problems with the component's files: loading, compiling, and fixture files that can't be rendered. Paths are relative to the component. */
  problems: { file: string; message: string }[];
  fixtures: FixtureCheck[];
  coverage: CoverageGoal[];
  /** Why Nu didn't run, when it was asked to. */
  nuSkipped: string | null;
  review: Review | null;
  reviewStatus: ReviewStatus | null;
  digest: string | null;
  /** Expected outputs written by `update`. */
  written: string[];
}

/**
 * Checks a component (spec §9.10): it compiles; each fixture renders in the
 * component's context and passes strict; each output equals its expected
 * file; the budget holds; and the fixtures together meet every coverage
 * goal. `update` writes the expected file for each fixture that renders
 * cleanly, to be reviewed before approval.
 */
export async function checkComponent(registry: Registry, id: string, options: LifecycleOptions & { update?: boolean } = {}): Promise<ComponentCheck> {
  const dir = join(registry.root, 'components', id);
  const component = registry.components.get(id);
  const broken = registry.problems.filter((p) => p.component === id);
  if (!component && broken.length === 0) {
    const near = closest(id, [...registry.components.keys()]);
    throw new LifecycleError(`there’s no component ${id} in ${registry.root}${near ? `; did you mean ${near}?` : ''}`);
  }
  const out: ComponentCheck = {
    id, version: component?.contract.version ?? null, status: 'fail', problems: [], fixtures: [], coverage: [], nuSkipped: null,
    review: component?.contract.provenance.review ?? null, reviewStatus: component?.status ?? null, digest: component?.digest ?? null, written: [],
  };
  for (const p of broken) out.problems.push({ file: relativeTo(dir, p.file), message: p.message });
  if (!component) return out;

  const coverage = new Coverage(id);
  for (const name of fixtureNames(dir, out.problems)) {
    const fixture = readFixture(dir, name, out.problems);
    if (!fixture) continue;
    if (isPage(component.contract) && fixture.with.length) {
      out.problems.push({ file: `fixtures/${name}.json`, message: '"with" is for fragment fixtures; a page’s fixture puts everything in its slots' });
      continue;
    }
    const values = validateRecord(component.contract.params, fixture.data, '', [] as Problem[], { schemes: DEFAULT_SCHEMES });
    if (values) coverage.data(component.contract.params, fixture.data, values);
    const result = await render(registry, component, name, fixture, options.config ?? null, coverage);
    const expectedPath = join(dir, 'fixtures', `${name}.html`);
    let expected = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8') : null;
    if (options.update && result.status === 'pass' && result.html !== null && result.html !== expected) {
      writeFileSync(expectedPath, result.html);
      expected = result.html;
      out.written.push(`fixtures/${name}.html`);
    }
    out.fixtures.push({ name, result, expected, matches: result.html !== null && result.html === expected, nu: [] });
  }

  // One Nu run for every fixture that rendered cleanly, each inside a page shell.
  const shells = out.fixtures.filter((f) => f.result.status === 'pass' && f.result.html !== null);
  if (options.nu && shells.length) {
    const inputs = shells.map((f) => ({ path: `fixtures/${f.name}.html (in a page shell)`, source: isPage(component.contract) ? f.result.html! : pageShell(component.contract.context, f.result.html!) }));
    const report = await check(inputs, { profile: 'strict', config: options.config ?? null, nu: options.nu });
    shells.forEach((f, i) => f.nu.push(...report.files[i]!.findings.filter((x) => x.rule === 'conformance/nu')));
    out.nuSkipped = report.files[0]!.coverage.untested.find((u) => u.check === 'conformance/nu')?.reason ?? null;
  }

  out.coverage = coverage.goals(component.template, component.contract);
  if (out.written.length) {
    // New expected outputs change the fixtures, and so the digest.
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'component.json'), 'utf8'));
    out.digest = componentDigest(raw, readFileSync(join(dir, 'template.html'), 'utf8'), fixtureFiles(dir));
    out.reviewStatus = out.review === null ? 'unreviewed' : out.review.digest === out.digest ? 'reviewed' : 'stale';
  }
  const clean = out.fixtures.every((f) => f.result.status === 'pass' && f.matches && !f.nu.some((n) => n.severity === 'error'));
  out.status = out.problems.length === 0 && out.fixtures.length > 0 && clean && out.coverage.every((g) => g.met) ? 'pass' : 'fail';
  return out;
}

/** Fixture names from fixtures/*.json; anything else in the directory is a problem, since it's part of the digest. */
function fixtureNames(dir: string, problems: ComponentCheck['problems']): string[] {
  const fixtures = join(dir, 'fixtures');
  const files = existsSync(fixtures) ? readdirSync(fixtures).sort().filter((f) => statSync(join(fixtures, f)).isFile()) : [];
  const names: string[] = [];
  for (const f of files) {
    const m = /^(.*)\.(json|html)$/.exec(f);
    if (!m) problems.push({ file: `fixtures/${f}`, message: 'isn’t a fixture; fixtures/ holds <name>.json, the data for one rendering, and <name>.html, its expected output' });
    else if (m[2] === 'json') {
      if (KEY.test(m[1]!)) names.push(m[1]!);
      else problems.push({ file: `fixtures/${f}`, message: 'needs a name of lowercase letters, digits, and hyphens, starting with a letter: the name is the instance key the fixture renders under' });
    } else if (!files.includes(`${m[1]}.json`)) problems.push({ file: `fixtures/${f}`, message: `is an expected output with no fixtures/${m[1]}.json to render it` });
  }
  if (!files.some((f) => f.endsWith('.json'))) problems.push({ file: 'fixtures/', message: 'has no fixtures; add fixtures/basic.json with the data for one rendering' });
  return names;
}

interface Fixture {
  text: string;
  data: unknown;
  slots: unknown;
  /** Siblings rendered after the component, such as the targets of its refs. */
  with: unknown[];
}

/** A fixture as a plan instance: the component, keyed by the fixture's name unless it's a page. */
function instanceOf(component: Component, name: string, fixture: Fixture): Record<string, unknown> {
  return { use: component.id, ...(isPage(component.contract) ? {} : { key: name }), ...(fixture.data !== undefined ? { data: fixture.data } : {}), ...(fixture.slots !== undefined ? { slots: fixture.slots } : {}) };
}

/**
 * Renders a fixture: the component in its context, followed by any siblings
 * the fixture names, under strict, with findings located in the fixture file.
 */
async function render(registry: Registry, component: Component, name: string, fixture: Fixture, config: Config | null, coverage?: Coverage): Promise<AssemblyResult> {
  const instance = instanceOf(component, name, fixture);
  const page = isPage(component.contract);
  const sources: [string, string][] = page
    ? [['/page', '']]
    : [['/fragment/children/0', ''], ...fixture.with.map((_, i): [string, string] => [`/fragment/children/${i + 1}`, `/with/${i}`])];
  const result = await assemble(page ? { page: instance } : { fragment: { context: component.contract.context, children: [instance, ...fixture.with] } }, {
    registry, profile: 'strict', config, draft: true, ...(coverage ? { coverage } : {}),
    planSource: fixture.text, planPath: `fixtures/${name}.json`, sourcePointers: sources, outPath: `fixtures/${name}.html`,
  });
  // Review status is what checking leads to, not a finding about the fixture.
  result.plan.findings = result.plan.findings.filter((f) => !(f.rule === 'assembly/component' && f.severity === 'warning'));
  return result;
}

function readFixture(dir: string, name: string, problems: ComponentCheck['problems']): Fixture | null {
  const file = `fixtures/${name}.json`;
  const text = readFileSync(join(dir, file), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    problems.push({ file, message: `isn’t valid JSON: ${(error as Error).message}` });
    return null;
  }
  if (!isObject(raw)) {
    problems.push({ file, message: 'must be { "data": { … }, "slots": { … }, "with": [ … ] }, each one optional' });
    return null;
  }
  const unknown = Object.keys(raw).filter((k) => k !== 'data' && k !== 'slots' && k !== 'with');
  if (unknown.length) {
    problems.push({ file, message: `has ${unknown.map((k) => `"${k}"`).join(', ')}; a fixture holds only "data", "slots", and "with"` });
    return null;
  }
  if (raw['with'] !== undefined && !Array.isArray(raw['with'])) {
    problems.push({ file, message: '"with" must be an array of plan children to render after the component, such as the targets of its refs' });
    return null;
  }
  return { text, data: raw['data'], slots: raw['slots'], with: (raw['with'] as unknown[] | undefined) ?? [] };
}

/** Where a fragment sits in a page, so Nu can check it in context: rows in a table, items in a list. */
const WRAP: Record<string, readonly string[]> = {
  tr: ['table', 'tbody', 'tr'], tbody: ['table', 'tbody'], thead: ['table', 'thead'], tfoot: ['table', 'tfoot'],
  colgroup: ['table', 'colgroup'], caption: ['table', 'caption'], td: ['table', 'tbody', 'tr', 'td'], th: ['table', 'tbody', 'tr', 'th'],
  li: ['ul', 'li'], dt: ['dl', 'dt'], dd: ['dl', 'dd'], option: ['select', 'option'], optgroup: ['select', 'optgroup'],
};

/** A minimal page around a fragment in its context. */
export function pageShell(context: string, html: string): string {
  const head = '<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Fixture</title>\n';
  if (context === 'head') return `<!doctype html>\n<html lang="en">\n<head>\n${head}${html}</head>\n<body>\n<main>\n<h1>Fixture</h1>\n</main>\n</body>\n</html>\n`;
  const chain = WRAP[context] ?? (context === 'body' || context === 'main' ? [] : [context]);
  const open = chain.map((t) => `<${t}>`).join('');
  const close = [...chain].reverse().map((t) => `</${t}>`).join('');
  return `<!doctype html>\n<html lang="en">\n<head>\n${head}</head>\n<body>\n<main>\n<h1>Fixture</h1>\n${open}${html}${close}\n</main>\n</body>\n</html>\n`;
}

export interface Approval {
  approved: boolean;
  check: ComponentCheck;
}

/**
 * Approves a component (spec §9.10): only after a clean check with full
 * coverage, recording the reviewer, the date, and the digest in
 * component.json. Nothing else in the file changes.
 */
export async function approveComponent(registry: Registry, id: string, by: string, options: LifecycleOptions & { date?: string } = {}): Promise<Approval> {
  if (by.trim() === '') throw new LifecycleError('approval needs the reviewer’s name: --by <name>');
  const result = await checkComponent(registry, id, options);
  if (result.status !== 'pass') return { approved: false, check: result };
  const review: Review = { by: by.trim(), date: options.date ?? new Date().toISOString().slice(0, 10), digest: result.digest! };
  const file = join(registry.root, 'components', id, 'component.json');
  writeFileSync(file, withReview(readFileSync(file, 'utf8'), review));
  return { approved: true, check: { ...result, review, reviewStatus: 'reviewed' } };
}

/** component.json with provenance.review set, edited in place so the rest of the file keeps its formatting. */
export function withReview(text: string, review: Review): string {
  const json = `{ "by": ${JSON.stringify(review.by)}, "date": "${review.date}", "digest": "${review.digest}" }`;
  const pointers = jsonPointers(text);
  const existing = pointers?.get('/provenance/review');
  if (existing !== undefined) return text.slice(0, existing) + json + text.slice(valueEnd(text, existing));
  const start = pointers?.get('/provenance');
  if (start === undefined) throw new LifecycleError('component.json has no "provenance" object to record the review in');
  const close = valueEnd(text, start) - 1;
  let last = close;
  while (last > start && /\s/.test(text[last - 1]!)) last--;
  if (last === start + 1) return `${text.slice(0, start + 1)} "review": ${json} ${text.slice(close)}`;
  const gap = text.slice(last, close);
  const indent = gap.includes('\n') ? `\n${gap.slice(gap.lastIndexOf('\n') + 1)}  ` : ' ';
  return `${text.slice(0, last)},${indent}"review": ${json}${text.slice(last)}`;
}

/** The offset just past the JSON value that starts at `start`. */
function valueEnd(text: string, start: number): number {
  const c = text[start];
  if (c === '"') {
    let i = start + 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return i + 1;
  }
  if (c !== '{' && c !== '[') {
    let i = start;
    while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') i = valueEnd(text, i) - 1;
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Scaffolds a component: a contract, a template, a fixture, and a README to fill in. Returns the files written, relative to the registry. */
export function newComponent(root: string, id: string, author: string): string[] {
  if (!COMPONENT_ID.test(id)) throw new LifecycleError(`"${id}" isn’t a component ID; use a group and a name, such as "content/callout"`);
  if (author.trim() === '') throw new LifecycleError('a component needs an author: --author <name>');
  const dir = join(root, 'components', id);
  if (existsSync(dir)) throw new LifecycleError(`components/${id} already exists`);
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  const contract = {
    id, version: '1.0.0', summary: 'One line on what it is.', use: 'When to use it, and what to use instead.', context: 'body',
    params: { text: { type: 'text', minLength: 1 } }, slots: {}, provenance: { authors: [author.trim()], aiAssisted: false },
  };
  const files: [string, string][] = [
    ['component.json', `${JSON.stringify(contract, null, 2)}\n`],
    ['template.html', '<p>{{text}}</p>\n'],
    ['fixtures/basic.json', '{ "data": { "text": "Example text." } }\n'],
    ['README.md', `# ${id}\n\nWhen to use it, and when not.\n`],
  ];
  for (const [file, content] of files) writeFileSync(join(dir, file), content);
  return files.map(([file]) => `components/${id}/${file}`);
}

export interface ComponentDetails {
  summary: ComponentSummary;
  contract: Contract;
  /** The basic fixture, or else the first: the instance a plan would hold, and what it renders. */
  example: { fixture: string; instance: Record<string, unknown>; html: string | null } | null;
}

/** A component's contract and an example of its use, for `component show` and the MCP server's get_component. */
export async function showComponent(registry: Registry, id: string, options: LifecycleOptions = {}): Promise<ComponentDetails> {
  const component = registry.components.get(id);
  if (!component) {
    const broken = registry.problems.find((p) => p.component === id);
    if (broken) throw new LifecycleError(`${id} didn’t load: ${relativeTo(join(registry.root, 'components', id), broken.file)}: ${broken.message}`);
    const near = closest(id, [...registry.components.keys()]);
    throw new LifecycleError(`there’s no component ${id} in ${registry.root}${near ? `; did you mean ${near}?` : ''}`);
  }
  const dir = join(registry.root, 'components', id);
  const names = fixtureNames(dir, []);
  const name = names.includes('basic') ? 'basic' : names[0];
  const fixture = name ? readFixture(dir, name, []) : null;
  const example = name && fixture ? { fixture: name, instance: instanceOf(component, name, fixture), html: (await render(registry, component, name, fixture, options.config ?? null)).html } : null;
  return { summary: catalog(registry).find((s) => s.id === id)!, contract: component.contract, example };
}

export interface RegistryCheck {
  status: 'pass' | 'fail';
  components: ComponentCheck[];
}

/** Checks every component, and requires each to be approved at its current digest: the CI gate (spec §9.10). */
export async function checkRegistry(registry: Registry, options: LifecycleOptions = {}): Promise<RegistryCheck> {
  const ids = [...new Set([...registry.components.keys(), ...registry.problems.map((p) => p.component)])].sort();
  const components: ComponentCheck[] = [];
  for (const id of ids) components.push(await checkComponent(registry, id, options));
  return { status: components.every((c) => c.status === 'pass' && c.reviewStatus === 'reviewed') ? 'pass' : 'fail', components };
}

export interface ComponentSummary {
  id: string;
  version: string;
  summary: string;
  use: string;
  context: string;
  status: ReviewStatus;
  params: Record<string, ParamSpec>;
  slots: Record<string, SlotSpec>;
  /** The catalog's line for it (spec §10.1). */
  line: string;
}

/** The catalog (spec §10.1): every component, or those whose ID, summary, or use mention `query`, by ID. */
export function catalog(registry: Registry | string, query?: string, config: Config | null = null): ComponentSummary[] {
  if (typeof registry === 'string') registry = openRegistry(registry, config);
  const q = query?.toLowerCase() ?? '';
  const list = [...registry.components.values()]
    .filter((c) => !q || [c.id, c.contract.summary, c.contract.use].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const width = Math.max(0, ...list.map((c) => `${c.id}@${major(c.contract)}`.length));
  return list.map((c) => ({
    id: c.id, version: c.contract.version, summary: c.contract.summary, use: c.contract.use, context: c.contract.context, status: c.status,
    params: c.contract.params, slots: c.contract.slots, line: `${`${c.id}@${major(c.contract)}`.padEnd(width)}  ${describe(c)}`,
  }));
}

function major(contract: Contract): string {
  return contract.version.split('.')[0]!;
}

/** "Form. data: action(url), method?=get|post. slots: fields[1..], actions[1..](action/submit)", and the review status unless approved. */
function describe(c: Component): string {
  const parts = [c.contract.summary.replace(/[.\s]*$/, '.')];
  const params = Object.entries(c.contract.params);
  if (params.length) parts.push(`data: ${params.map(([name, spec]) => param(name, spec)).join(', ')}.`);
  const slots = Object.entries(c.contract.slots);
  if (slots.length) parts.push(`slots: ${slots.map(([name, s]) => `${name}${range(s.min, s.max)}${s.accepts ? `(${s.accepts.join('|')})` : ''}`).join(', ')}.`);
  if (c.status !== 'reviewed') parts.push(`[${c.status}]`);
  return parts.join(' ');
}

function param(name: string, spec: ParamSpec): string {
  const optional = spec.required ? '' : '?';
  if (spec.type === 'enum') return `${name}${optional}=${spec.values!.join('|')}`;
  if (spec.type === 'list') {
    const items = typeof spec.items === 'object' ? Object.entries(spec.items).map(([n, s]) => param(n, s)).join(', ') : spec.items!;
    return `${name}${optional}${range(spec.minItems ?? 0, spec.maxItems ?? null) || '[]'}(${items})`;
  }
  if (spec.type === 'ref' && spec.accepts) return `${name}${optional}(ref ${spec.accepts.join('|')})`;
  return `${name}${optional}${spec.type === 'text' ? '' : `(${spec.type})`}`;
}

/** "[1..]", "[1..3]", or "" for any number. */
function range(min: number, max: number | null): string {
  return min === 0 && max === null ? '' : `[${min}..${max ?? ''}]`;
}

function relativeTo(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}
