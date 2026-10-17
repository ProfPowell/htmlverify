// Assembly (spec §9.8): a plan and a registry in, a checked page or fragment
// out. Findings in the output are traced to their origin and classified as
// plan, component, or composition problems, so the fix goes to the right place.

import { relative, sep } from 'node:path';
import { defaultTreeAdapter as tree } from 'parse5';
import { resolveProfile, type Config } from '../config.ts';
import { LineIndex } from '../parse/lines.ts';
import { parseHtml } from '../parse/parse.ts';
import { isElement, walk, type Element, type Node } from '../parse/tree.ts';
import type { ProfileName } from '../profiles.ts';
import { check, type Finding, type Origin, type Report } from '../report/report.ts';
import { RULE_BY_ID } from '../rules/registry.ts';
import type { Severity } from '../rules/types.ts';
import { NS } from '../spec/html.ts';
import { closest } from '../text.ts';
import { vocabularyBooleans } from '../vocab/booleans.ts';
import { Vocabulary } from '../vocab/vocabulary.ts';
import { isPage } from './contract.ts';
import { misfit, slotAncestors } from './fit.ts';
import { Builder, type AssemblyProblem, type Built } from './instantiate.ts';
import { jsonPointers, offsetOf } from './jsonpos.ts';
import { DEFAULT_SCHEMES, validateRecord, type Problem, type Value } from './params.ts';
import { parsePlan, type PlanInstance, type PlanNode } from './plan.ts';
import { loadRegistry, type Component, type Registry } from './registry.ts';
import { compareTrees } from './roundtrip.ts';
import { serialize, type OutputRange } from './serialize.ts';

export interface AssembleOptions {
  /** The registry, or its directory to load it from. */
  registry: Registry | string;
  profile?: ProfileName;
  config?: Config | null;
  /** Allows unreviewed and stale components, with a warning (spec §9.4). */
  draft?: boolean;
  /** Schemes url parameters may use; https, http, mailto, and tel by default. */
  schemes?: readonly string[];
  /** False forbids HTML nodes in plans (spec §9.6); the config's "htmlNodes" by default. */
  htmlNodes?: boolean;
  /** The plan's text and path, to locate plan findings; a plan given as text is its own source. */
  planSource?: string;
  planPath?: string;
  /** The path the output is reported under. */
  outPath?: string;
}

export interface AssemblyResult {
  status: 'pass' | 'fail';
  /** The output, whenever it could be built; write it only on pass, or as name.failed.html. */
  html: string | null;
  /** assembly/* findings, located in the plan. */
  plan: { path: string; findings: Finding[] };
  /** The check of the output, its findings carrying their origins; null when nothing was built. */
  report: Report | null;
  /** The exact version and digest of every component used (spec §9.7). */
  components: { id: string; version: string; digest: string; status: Component['status'] }[];
  /** HTML nodes: places the registry didn't cover (spec §9.6). */
  gaps: { instance: string; plan: string }[];
}

/**
 * Assembles a plan: parsed JSON, or its text. A plan is an object, so a
 * string is always JSON text; invalid JSON is an assembly/plan finding.
 */
export async function assemble(input: unknown, options: AssembleOptions): Promise<AssemblyResult> {
  const profile = resolveProfile(options.profile, options.config ?? null);
  const vocabulary = new Vocabulary(profile.vocabularies, profile.elements, profile.options.adHocPrefix);
  const registry = typeof options.registry === 'string' ? loadRegistry(options.registry, vocabulary) : options.registry;
  const planPath = options.planPath ?? 'plan.json';
  const text = typeof input === 'string' ? input : null;
  const located = new PlanLocator(planPath, options.planSource ?? text);
  const fail = (findings: Finding[], extra: Partial<AssemblyResult> = {}): AssemblyResult =>
    ({ status: 'fail', html: null, plan: { path: planPath, findings: inPlanOrder(findings) }, report: null, components: [], gaps: [], ...extra });

  let raw = input;
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const message = (error as Error).message;
      const position = /at position (\d+)/.exec(message);
      return fail([located.finding('assembly/plan', '', `isn’t valid JSON: ${message.replace(/ in JSON at position.*$/, '')}`, 'error', position ? Number(position[1]) : 0)]);
    }
  }

  const { plan, problems: planProblems } = parsePlan(raw);
  if (!plan) return fail(planProblems.map((p) => located.finding(p.rule, p.pointer, p.message)));

  const findings: Finding[] = [];
  const add = (p: AssemblyProblem, severity?: Severity) => {
    const configured = profile.severities[p.rule] ?? 'error';
    if (configured !== 'off') findings.push(located.finding(p.rule, p.pointer, p.message, severity ?? configured));
  };
  const schemes = options.schemes ?? DEFAULT_SCHEMES;

  // Resolve components, check review status, validate data and slots, and
  // pre-check that each child fits where its slot is.
  const components = new Map<PlanInstance, Component>();
  const data = new Map<PlanInstance, Record<string, Value>>();
  const used = new Map<string, Component>();
  /** `chain` is where the node's roots go: ancestor element names, outermost first. */
  const visit = (node: PlanNode, root: boolean, chain: readonly string[]) => {
    if (node.kind === 'html') {
      if ((options.htmlNodes ?? options.config?.htmlNodes) === false) add({ rule: 'assembly/plan', pointer: node.pointer, message: 'HTML nodes are turned off in this project; use a component.' });
      return;
    }
    const component = resolve(node, registry, add);
    const slotChains = component ? slotAncestors(component.template) : new Map<string, string[]>();
    if (component) validate(node, component, root, chain);
    for (const [name, children] of Object.entries(node.slots)) {
      // Without a component there's no telling where the children go.
      const inner = component ? [...chain, ...(slotChains.get(name) ?? [])] : [];
      for (const child of children) visit(child, false, inner);
    }
  };
  const validate = (node: PlanInstance, component: Component, root: boolean, chain: readonly string[]) => {
    components.set(node, component);
    // Review status is the component's, so it's reported once, where it's first used.
    if (component.status !== 'reviewed' && !used.has(component.id)) {
      const what = `${node.use}@${component.contract.version} ${component.status === 'stale' ? 'changed since it was approved' : 'hasn’t been approved'}`;
      if (profile.name === 'strict' && !options.draft) add({ rule: 'assembly/component', pointer: `${node.pointer}/use`, message: `${what}; strict assembles only approved components, so have it checked and approved, or assemble with --draft` });
      else add({ rule: 'assembly/component', pointer: `${node.pointer}/use`, message: `${what}, so nobody has vouched for its markup yet` }, 'warning');
    }
    used.set(component.id, component);
    // A component in the wrong place needs replacing, which makes its data moot.
    if (isPage(component.contract) !== root) {
      add({ rule: 'assembly/component', pointer: `${node.pointer}/use`, message: root ? `${node.use} isn’t a page component; a page plan starts with one, such as page/basic.` : `${node.use} is a page component; it goes only at the root of a page plan.` });
      return;
    }
    const fit = misfit(component.template, chain, vocabulary);
    if (fit) add({ rule: 'assembly/slot', pointer: `${node.pointer}/use`, message: `${node.use} doesn’t fit in <${chain.at(-1)}>: ${fit}` });
    const problems: Problem[] = [];
    const values = validateRecord(component.contract.params, node.data, `${node.pointer}/data`, problems, { schemes });
    for (const p of problems) add({ rule: 'assembly/data', ...p });
    if (values) data.set(node, values);
    const slots = component.contract.slots;
    for (const name of Object.keys(node.slots)) {
      if (!slots[name]) {
        const near = closest(name, Object.keys(slots));
        add({ rule: 'assembly/slot', pointer: `${node.pointer}/slots/${name}`, message: `${node.use} has no slot "${name}"${near ? `; did you mean "${near}"?` : Object.keys(slots).length ? `; its slots are ${Object.keys(slots).join(', ')}` : '; it has no slots'}` });
      }
    }
    for (const [name, spec] of Object.entries(slots)) {
      const children = node.slots[name] ?? [];
      const pointer = `${node.pointer}/slots/${name}`;
      if (children.length < spec.min) add({ rule: 'assembly/slot', pointer, message: `the slot "${name}" of ${node.use} needs at least ${spec.min} child${spec.min === 1 ? '' : 'ren'}; it has ${children.length}` });
      if (spec.max !== null && children.length > spec.max) add({ rule: 'assembly/slot', pointer, message: `the slot "${name}" of ${node.use} takes at most ${spec.max} child${spec.max === 1 ? '' : 'ren'}; it has ${children.length}` });
      if (spec.accepts) {
        children.forEach((child, i) => {
          if (child.kind === 'component' && !spec.accepts!.includes(child.use)) {
            add({ rule: 'assembly/slot', pointer: `${pointer}/${i}/use`, message: `the slot "${name}" of ${node.use} takes ${spec.accepts!.join(', ')}, not ${child.use}` });
          }
        });
      }
    }
  };
  if (plan.kind === 'page') visit(plan.root, true, []);
  else for (const child of plan.children) visit(child, false, [plan.context]);
  const componentList = [...used.values()].map((c) => ({ id: c.id, version: c.contract.version, digest: c.digest, status: c.status }));
  if (findings.some((f) => f.severity === 'error')) return fail(findings, { components: componentList });

  // Instantiate and serialize, recording where each element was written.
  const booleans = vocabularyBooleans(vocabulary);
  const builder = new Builder(components, data, { values: { schemes }, check: { config: options.config ?? null } });
  const built = plan.kind === 'page' ? await builder.page(plan.root) : await builder.fragment(plan.context, plan.rank, plan.children);
  for (const p of built.problems) add(p);
  const context = plan.kind === 'page' ? null : plan.context;
  const contextElement = context === null ? null : tree.createElement(context, NS.html as never, []);
  const serializeOptions = { voidElements: profile.options.voidElements, booleanValue: profile.options.booleanValue, vocabulary, isBoolean: booleans, context: contextElement };
  const ranges = new Map<Element, OutputRange>();
  const html = serialize(built.root, serializeOptions, ranges);
  // Assembly errors leave known gaps in the output, such as a link whose ref
  // didn't resolve, so the output is checked once the plan builds cleanly.
  if (findings.some((f) => f.severity === 'error')) return fail(findings, { html, components: componentList, gaps: built.gaps });

  // Check the output, and trace each finding to where it came from.
  const outPath = options.outPath ?? 'page.html';
  const report = await check({ path: outPath, source: html, context }, { profile: profile.name, config: options.config ?? null });
  const file = report.files[0]!;

  // Prove the output parses back to the tree that was built. Where the parser
  // restructures it, the syntax findings say why, at their origin; a
  // difference they don't explain is the assembler's own bug.
  const reparsed = parseHtml(html, context).root;
  const difference = compareTrees(built.root, reparsed, serializeOptions);
  const origins = new Tracer(built, ranges, difference ? reparsed : null);
  for (const f of file.findings) f.origin = origins.classify(f);
  if (difference && !file.findings.some((f) => f.severity === 'error' && RESTRUCTURING.has(f.rule))) {
    add({ rule: 'assembly/round-trip', pointer: plan.kind === 'page' ? '/page' : '/fragment', message: `The output doesn’t parse back to the tree that was built, at ${difference.path}: built ${difference.expected}, parsed ${difference.found}. This is an assembler bug; please report it with the plan.` });
  }
  const failed = findings.some((f) => f.severity === 'error') || report.status !== 'pass';
  return { status: failed ? 'fail' : 'pass', html, plan: { path: planPath, findings: inPlanOrder(findings) }, report, components: componentList, gaps: built.gaps };
}

/** Plan findings in the order they appear in plan.json; the sort is stable, so without its text they keep the order found. */
function inPlanOrder(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => a.offset - b.offset);
}

/** Finds a plan instance's component and checks its pin. */
function resolve(node: PlanInstance, registry: Registry, add: (p: AssemblyProblem) => void): Component | null {
  const pointer = `${node.pointer}/use`;
  const component = registry.components.get(node.use);
  if (!component) {
    const broken = registry.problems.find((p) => p.component === node.use);
    if (broken) {
      const more = registry.problems.filter((p) => p.component === node.use).length - 1;
      const file = relative(registry.root, broken.file).split(sep).join('/');
      add({ rule: 'assembly/component', pointer, message: `${node.use} didn’t load: ${file}: ${broken.message}${more ? ` (and ${more} more)` : ''}` });
    } else {
      const near = closest(node.use, [...registry.components.keys()]);
      add({ rule: 'assembly/component', pointer, message: `there’s no component ${node.use} in the registry${near ? `; did you mean ${near}?` : ''}` });
    }
    return null;
  }
  const version = component.contract.version;
  if (node.pin && !(node.pin === version || (!node.pin.includes('.') && version.split('.')[0] === node.pin))) {
    add({ rule: 'assembly/component', pointer, message: `${node.use}@${node.pin} isn’t available; the registry has ${version}` });
    return null;
  }
  return component;
}

/** Plan findings, located in plan.json when its text is at hand. */
class PlanLocator {
  readonly #path: string;
  readonly #pointers: Map<string, number> | null;
  readonly #lines: LineIndex | null;

  constructor(path: string, source: string | null) {
    this.#path = path;
    this.#pointers = source === null ? null : jsonPointers(source);
    this.#lines = source === null ? null : new LineIndex(source);
  }

  finding(rule: string, pointer: string, message: string, severity: Severity = 'error', at?: number): Finding {
    const offset = at ?? (this.#pointers ? offsetOf(this.#pointers, pointer) : 0);
    const p = this.#lines ? this.#lines.position(offset) : { line: 1, column: 1 };
    return {
      rule, severity, authority: RULE_BY_ID.get(rule)?.authority ?? 'policy',
      message: `${pointer || '/'}: ${message}${/[.?!]$/.test(message) ? '' : '.'}`,
      path: this.#path, line: p.line, column: p.column, endLine: p.line, endColumn: p.column, offset, endOffset: offset,
      evidence: { pointer }, fix: null, origin: null,
    };
  }
}

/** Rules about how elements relate to their neighbors, which composition can break. */
const STRUCTURE = new Set([
  'content/child', 'content/order', 'content/context', 'content/descendant', 'content/duplicate-id', 'content/idref',
  'a11y/landmarks', 'a11y/headings', 'policy/single-h1', 'semantic/section-heading',
]);
/** Parse errors that change the tree, which putting components together can cause. */
const RESTRUCTURING = new Set(['syntax/unclosed-element', 'syntax/stray-end-tag', 'syntax/misplaced-start-tag', 'syntax/misnested', 'syntax/reordered']);
/** Rules about text content, which data supplies. */
const TEXT = new Set(['semantic/placeholder-content', 'a11y/link-text', 'a11y/name', 'semantic/empty-element', 'semantic/link-href']);

/**
 * Maps output findings to their origins: the innermost element written
 * around a finding's offset leads back to the built element and its origin.
 * The serializer's ranges don't depend on the reparse, so this holds even
 * where the parser restructured the output.
 */
class Tracer {
  readonly #built: Built;
  readonly #ranges: ReadonlyMap<Element, OutputRange>;
  /** When the parser restructured the output: its elements by start tag offset. */
  readonly #parsed: Map<number, Element> | null = null;

  constructor(built: Built, ranges: ReadonlyMap<Element, OutputRange>, restructured: Node | null) {
    this.#built = built;
    this.#ranges = ranges;
    if (restructured) {
      this.#parsed = new Map();
      for (const { node } of walk(restructured)) if (isElement(node) && node.sourceCodeLocation) this.#parsed.set(node.sourceCodeLocation.startOffset, node);
    }
  }

  classify(f: Finding): Origin | null {
    const element = this.#at(f.offset);
    const origin = element && this.#built.origins.get(element);
    if (!element || !origin) return null;
    const as = (kind: Origin['kind'], o = origin): Origin => ({ kind, component: o.component, template: o.template, instance: o.instance, plan: o.plan });
    // Content the parser moved out of the element explains anything found there.
    const moved = this.#moved(element, origin.instance);
    if (moved) return as('composition', this.#built.origins.get(moved)!);
    const attribute = typeof f.evidence?.['attribute'] === 'string'
      ? f.evidence['attribute']
      : this.#ranges.get(element)!.attributes.find((a) => a.start <= f.offset && f.offset < a.end)?.name ?? null;
    if (origin.source !== 'template') return as('plan');
    if (attribute && this.#built.bound.get(element)?.has(attribute)) return as('plan');
    if (TEXT.has(f.rule) && this.#built.dataText.has(element)) return as('plan');
    if ((STRUCTURE.has(f.rule) || RESTRUCTURING.has(f.rule)) && this.#crossing(f, element, origin.instance)) return as('composition');
    return as('component');
  }

  /** The innermost element written around an offset. */
  #at(offset: number): Element | null {
    let found: Element | null = null;
    let start = -1;
    for (const [e, r] of this.#ranges) {
      if (r.start <= offset && offset < r.end && r.start >= start) {
        found = e;
        start = r.start;
      }
    }
    return found;
  }

  #foreign(n: Node | null, instance: string): boolean {
    return n !== null && (isElement(n) ? this.#built.origins.get(n)?.instance !== instance : n.nodeName === '#document-fragment');
  }

  /**
   * The first element of another instance that was built inside `element`
   * but parsed outside it: what the parser moved out, such as a block that
   * closed a paragraph. Null when nothing moved, or the element itself
   * didn't survive the parse.
   */
  #moved(element: Element, instance: string): Element | null {
    const parsed = this.#parsed?.get(this.#ranges.get(element)!.start);
    if (!parsed) return null;
    for (const { node } of walk(element)) {
      if (node === element || !isElement(node) || !this.#foreign(node, instance)) continue;
      let p: Node | null = this.#parsed!.get(this.#ranges.get(node)?.start ?? -1) ?? null;
      while (p && p !== parsed) p = isElement(p) ? p.parentNode : null;
      if (!p) return node;
    }
    return null;
  }

  /**
   * Whether a structural finding crosses from one instance into another:
   * the element's context, its parent (a fragment's context at its top
   * level) or for a prohibited descendant the ancestor that forbids it,
   * comes from another instance than the element.
   */
  #crossing(f: Finding, element: Element, instance: string): boolean {
    if (this.#foreign(element.parentNode, instance)) return true;
    const ancestor = f.evidence?.['ancestorOffset'];
    return typeof ancestor === 'number' && this.#foreign(this.#at(ancestor), instance);
  }
}
