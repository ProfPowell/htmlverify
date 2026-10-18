// Plans (spec §9.7): which components to use, their data, and what goes in
// their slots. Unknown properties are errors at every level, so typos fail
// loudly; keys follow §9.6.

import { LineIndex } from '../parse/lines.ts';
import { at, isObject } from './params.ts';

export interface PlanInstance {
  kind: 'component';
  /** The component ID, without a version pin. */
  use: string;
  /** "1.0.0", "1", or null for the registry's current version. */
  pin: string | null;
  /** Null only for a page's root instance. */
  key: string | null;
  data: unknown;
  slots: Record<string, PlanNode[]>;
  pointer: string;
}

/** Hand-written HTML where no component fits (spec §9.6), reported as a registry gap. */
export interface PlanHtml {
  kind: 'html';
  key: string;
  html: string;
  pointer: string;
}

export type PlanNode = PlanInstance | PlanHtml;

export type Plan =
  | { kind: 'page'; root: PlanInstance }
  /** A fragment's headings start below `rank`: the level of the heading it sits under. */
  | { kind: 'fragment'; context: string; rank: number; children: PlanNode[]; pointer: string };

export interface PlanProblem {
  rule: 'assembly/plan' | 'assembly/key';
  pointer: string;
  message: string;
}

export const KEY = /^[a-z][a-z0-9-]*$/;
const USE = /^([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+)(?:@(\d+(?:\.\d+\.\d+)?))?$/;

/** Validates parsed plan JSON; returns the plan only when there are no problems. */
export function parsePlan(raw: unknown): { plan: Plan | null; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const problem = (pointer: string, message: string, rule: PlanProblem['rule'] = 'assembly/plan') => problems.push({ rule, pointer, message });
  const unknown = (value: Record<string, unknown>, pointer: string, allowed: readonly string[]) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problem(at(pointer, key), `unknown property "${key}"; expected ${allowed.map((k) => `"${k}"`).join(', ')}`);
  };

  const node = (value: unknown, pointer: string, root: boolean): PlanNode | null => {
    if (!isObject(value)) {
      problem(pointer, 'must be an object: { "use", "key", "data", "slots" }, or { "key", "html" }');
      return null;
    }
    const key = value['key'];
    if (key === undefined && !root) problem(pointer, 'needs a "key"', 'assembly/key');
    else if (key !== undefined && !(typeof key === 'string' && KEY.test(key))) problem(at(pointer, 'key'), 'must be lowercase letters, digits, and hyphens, starting with a letter, such as "contact" or "email-2"', 'assembly/key');
    if ('html' in value && !('use' in value)) {
      unknown(value, pointer, ['key', 'html']);
      if (typeof value['html'] !== 'string') problem(at(pointer, 'html'), 'must be a string of HTML');
      return typeof key === 'string' && typeof value['html'] === 'string' ? { kind: 'html', key, html: value['html'], pointer } : null;
    }
    unknown(value, pointer, ['use', 'key', 'data', 'slots']);
    const use = value['use'];
    const m = typeof use === 'string' ? USE.exec(use) : null;
    if (!m) problem(at(pointer, 'use'), 'must name a component, such as "form/text-field", optionally pinned: "form/text-field@1" or "@1.0.0"');
    if (value['data'] !== undefined && !isObject(value['data'])) problem(at(pointer, 'data'), 'must be an object of parameter values');
    const slots: Record<string, PlanNode[]> = {};
    const rawSlots = value['slots'];
    if (rawSlots !== undefined && !isObject(rawSlots)) problem(at(pointer, 'slots'), 'must be an object of slot names to arrays of children');
    const keys = new Map<string, string>();
    if (isObject(rawSlots)) {
      for (const [name, children] of Object.entries(rawSlots)) {
        const where = at(at(pointer, 'slots'), name);
        if (!Array.isArray(children)) {
          problem(where, 'must be an array of children');
          continue;
        }
        slots[name] = list(children, where, keys);
      }
    }
    if (!m || (key !== undefined && typeof key !== 'string')) return null;
    return { kind: 'component', use: m[1]!, pin: m[2] ?? null, key: typeof key === 'string' ? key : null, data: value['data'] ?? {}, slots, pointer };
  };

  /** Children of one instance; keys are unique across all of its slots. */
  const list = (children: unknown[], pointer: string, keys: Map<string, string>): PlanNode[] => {
    const out: PlanNode[] = [];
    children.forEach((child, i) => {
      const n = node(child, at(pointer, i), false);
      if (!n) return;
      const taken = keys.get(n.key!);
      if (taken) problem(at(at(pointer, i), 'key'), `"${n.key}" is already the key of ${taken}; keys are unique among an instance’s children`, 'assembly/key');
      else keys.set(n.key!, at(pointer, i));
      out.push(n);
    });
    return out;
  };

  if (!isObject(raw)) {
    problem('', 'a plan is { "page": { … } } or { "fragment": { "context": "…", "children": [ … ] } }');
    return { plan: null, problems };
  }
  unknown(raw, '', ['$schema', 'page', 'fragment']);
  if (('page' in raw) === ('fragment' in raw)) {
    problem('', 'a plan has exactly one of "page" and "fragment"');
    return { plan: null, problems };
  }
  let plan: Plan | null = null;
  if ('page' in raw) {
    const root = node(raw['page'], '/page', true);
    if (root && root.kind === 'html') problem('/page', 'a page is a component, not HTML');
    else if (root) plan = { kind: 'page', root };
  } else {
    const f = raw['fragment'];
    if (!isObject(f)) problem('/fragment', 'must be { "context": "…", "children": [ … ] }');
    else {
      unknown(f, '/fragment', ['context', 'rank', 'children']);
      const context = f['context'];
      if (!(typeof context === 'string' && /^[a-z][a-z0-9-]*$/.test(context))) problem('/fragment/context', 'must be the element the fragment goes in, such as "main" or "tbody"');
      const rank = f['rank'] ?? 1;
      if (!(typeof rank === 'number' && Number.isInteger(rank) && rank >= 0 && rank <= 5)) problem('/fragment/rank', 'must be the level of the heading the fragment sits under, 0 to 5');
      const children = f['children'];
      if (!Array.isArray(children)) problem('/fragment/children', 'must be an array of children');
      else {
        const nodes = list(children, '/fragment/children', new Map());
        if (typeof context === 'string' && typeof rank === 'number') plan = { kind: 'fragment', context, rank, children: nodes, pointer: '/fragment' };
      }
    }
  }
  return { plan: problems.length ? null : plan, problems };
}


/**
 * For plan text that isn't valid JSON: the first bracket that doesn't pair
 * up, named by its key, which a parser's own message ("Expected ',' or '}'")
 * leaves the reader to find. Null when the brackets balance.
 */
export function unmatchedBracket(text: string): { offset: number; message: string } | null {
  const lines = new LineIndex(text);
  const at = (offset: number) => {
    const p = lines.position(offset);
    return `${p.line}:${p.column}`;
  };
  const open: { char: string; offset: number; key: string | null }[] = [];
  const name = (b: (typeof open)[number]) => `the "${b.char}"${b.key === null ? '' : ` of "${b.key}"`} at ${at(b.offset)}`;
  const closer = (char: string) => (char === '{' ? '}' : ']');
  let key: string | null = null;
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      last = text.slice(i + 1, j);
      i = j;
    } else if (c === ':') key = last;
    else if (c === '{' || c === '[') {
      open.push({ char: c, offset: i, key });
      key = null;
    } else if (c === '}' || c === ']') {
      const top = open.pop();
      if (!top) return { offset: i, message: `the "${c}" at ${at(i)} closes nothing, since the brackets before it balance; remove it` };
      if (closer(top.char) !== c) return { offset: i, message: `the "${c}" at ${at(i)} can’t close ${name(top)}, which needs "${closer(top.char)}"` };
      key = null;
    } else if (c === ',') key = null;
  }
  const top = open.at(-1);
  return top ? { offset: top.offset, message: `${name(top)} is never closed; add its "${closer(top.char)}"` } : null;
}
