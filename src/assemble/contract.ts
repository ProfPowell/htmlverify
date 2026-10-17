// A component's contract (spec §9.4): what it is for, its parameters and
// slots, its budget, and its review. Validation is strict and reports every
// problem with a JSON Pointer.

import { HTML_ELEMENTS } from '../spec/data.ts';
import { isCustomElementName } from '../spec/model.ts';
import { at, isObject, NAME, parseParams, type ParamSpec, type Problem } from './params.ts';

export interface SlotSpec {
  /** Component IDs the slot is narrowed to, or null for anything that fits where it sits. */
  accepts: string[] | null;
  min: number;
  max: number | null;
  description: string | null;
}

export interface Review {
  by: string;
  date: string;
  digest: string;
}

export interface Contract {
  id: string;
  version: string;
  summary: string;
  use: string;
  /** The parent element the template is parsed in, or "document" for a whole page. */
  context: string;
  params: Record<string, ParamSpec>;
  slots: Record<string, SlotSpec>;
  budget: { elements: number } | null;
  obligations: string[];
  provenance: { authors: string[]; aiAssisted: boolean; review: Review | null };
}

export class ContractError extends Error {
  readonly problems: readonly Problem[];
  constructor(source: string, problems: readonly Problem[]) {
    super(`${source}:\n${problems.map((p) => `  ${p.pointer || '/'}: ${p.message}`).join('\n')}`);
    this.problems = problems;
  }
}

export const COMPONENT_ID = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const KEYS = new Set(['$schema', 'id', 'version', 'summary', 'use', 'context', 'params', 'slots', 'budget', 'obligations', 'provenance']);

/** A page component is parsed as a whole document; it alone may hold literal IDs and headings. */
export const isPage = (contract: Contract) => contract.context === 'document';

/** Validates parsed component.json; `source` names it in errors. */
export function parseContract(raw: unknown, source: string): Contract {
  const problems: Problem[] = [];
  const problem = (pointer: string, message: string) => problems.push({ pointer, message });
  if (!isObject(raw)) throw new ContractError(source, [{ pointer: '', message: 'component.json must be a JSON object' }]);
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) problem(at('', key), `unknown key "${key}"`);

  const text = (key: string, { optional = false, line = false } = {}): string => {
    const v = raw[key];
    if (v === undefined && optional) return '';
    if (typeof v !== 'string' || v.trim() === '') problem(at('', key), 'must be a non-empty string');
    else if (line && /\n/.test(v)) problem(at('', key), 'must be one line');
    return typeof v === 'string' ? v : '';
  };
  const id = text('id');
  if (id && !COMPONENT_ID.test(id)) problem('/id', 'must be a group and a name, such as "form/text-field"');
  const version = text('version');
  if (version && !VERSION.test(version)) problem('/version', 'must be a semantic version, such as "1.0.0"');
  const summary = text('summary', { line: true });
  const use = text('use');

  const context = raw['context'] ?? 'body';
  if (typeof context !== 'string' || !(context === 'document' || HTML_ELEMENTS.has(context) || isCustomElementName(context) || context === 'svg' || context === 'math')) {
    problem('/context', 'must be "document" or an element name, such as "body", "form", "tbody", or "ul"');
  }

  const params = parseParams(raw['params'], '/params', problems);

  const slots: Record<string, SlotSpec> = {};
  const rawSlots = raw['slots'] ?? {};
  if (!isObject(rawSlots)) problem('/slots', 'must be an object of slot declarations');
  else {
    for (const [name, spec] of Object.entries(rawSlots)) {
      const pointer = at('/slots', name);
      if (!NAME.test(name)) problem(pointer, `"${name}" isn’t a valid name: use letters and digits, starting with a lowercase letter`);
      if (params[name]) problem(pointer, `"${name}" is also a parameter; slots and parameters share one namespace`);
      if (!isObject(spec)) {
        problem(pointer, 'must be an object');
        continue;
      }
      for (const key of Object.keys(spec)) if (!['accepts', 'min', 'max', 'description'].includes(key)) problem(at(pointer, key), `unknown key "${key}"`);
      const accepts = spec['accepts'];
      if (accepts !== undefined && !(Array.isArray(accepts) && accepts.length > 0 && accepts.every((a) => typeof a === 'string' && COMPONENT_ID.test(a)))) {
        problem(at(pointer, 'accepts'), 'must be a non-empty array of component IDs');
      }
      const min = spec['min'] ?? 0;
      const max = spec['max'] ?? null;
      if (!(typeof min === 'number' && Number.isInteger(min) && min >= 0)) problem(at(pointer, 'min'), 'must be a non-negative integer');
      if (max !== null && !(typeof max === 'number' && Number.isInteger(max) && max >= 1 && (typeof min !== 'number' || max >= min))) {
        problem(at(pointer, 'max'), 'must be a positive integer no less than "min"');
      }
      if (spec['description'] !== undefined && typeof spec['description'] !== 'string') problem(at(pointer, 'description'), 'must be a string');
      slots[name] = {
        accepts: Array.isArray(accepts) ? (accepts as string[]) : null,
        min: typeof min === 'number' ? min : 0,
        max: typeof max === 'number' ? max : null,
        description: typeof spec['description'] === 'string' ? spec['description'] : null,
      };
    }
  }

  let budget: Contract['budget'] = null;
  if (raw['budget'] !== undefined) {
    const b = raw['budget'];
    if (!isObject(b) || Object.keys(b).some((k) => k !== 'elements') || !(typeof b['elements'] === 'number' && Number.isInteger(b['elements']) && b['elements'] >= 1)) {
      problem('/budget', 'must be { "elements": n }, a positive integer');
    } else budget = { elements: b['elements'] };
  }

  const obligations = raw['obligations'] ?? [];
  if (!(Array.isArray(obligations) && obligations.every((o) => typeof o === 'string' && o.trim() !== ''))) problem('/obligations', 'must be an array of non-empty strings');

  const provenance = raw['provenance'];
  let review: Review | null = null;
  let authors: string[] = [];
  let aiAssisted = false;
  if (!isObject(provenance)) problem('/provenance', 'must be an object with "authors" and "aiAssisted"');
  else {
    for (const key of Object.keys(provenance)) if (!['authors', 'aiAssisted', 'review'].includes(key)) problem(at('/provenance', key), `unknown key "${key}"`);
    if (Array.isArray(provenance['authors']) && provenance['authors'].length > 0 && provenance['authors'].every((a) => typeof a === 'string' && a.trim() !== '')) authors = provenance['authors'] as string[];
    else problem('/provenance/authors', 'must be a non-empty array of names');
    if (typeof provenance['aiAssisted'] === 'boolean') aiAssisted = provenance['aiAssisted'];
    else problem('/provenance/aiAssisted', 'must be true or false');
    const r = provenance['review'];
    if (r !== undefined) {
      if (!isObject(r) || Object.keys(r).some((k) => !['by', 'date', 'digest'].includes(k))) problem('/provenance/review', 'must be { "by", "date", "digest" }');
      else if (typeof r['by'] !== 'string' || r['by'].trim() === '') problem('/provenance/review/by', 'must name the reviewer');
      else if (typeof r['date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r['date'])) problem('/provenance/review/date', 'must be a date such as "2026-10-20"');
      else if (typeof r['digest'] !== 'string' || !/^sha256-[0-9a-f]{64}$/.test(r['digest'])) problem('/provenance/review/digest', 'must be "sha256-" followed by 64 hex digits');
      else review = { by: r['by'], date: r['date'], digest: r['digest'] };
    }
  }

  if (problems.length) throw new ContractError(source, problems);
  return {
    id, version, summary, use, context: context as string, params, slots, budget,
    obligations: obligations as string[],
    provenance: { authors, aiAssisted, review },
  };
}
