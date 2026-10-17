// Compiles Vanilla Breeze's api.json manifests into a vocabulary snapshot
// (spec §3.4, §7.4). The snapshot keeps the fields htmlverify checks, in a
// stable shape, so a regenerated snapshot diffs cleanly.

import { HTML_ELEMENTS } from '../spec/data.ts';
import { isCustomElementName } from '../spec/model.ts';
import type { AttributeType, Snapshot, VocabAttribute, VocabChildAttribute, VocabElement } from './types.ts';

export class VocabError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.length === 1 ? problems[0]! : `the manifests have ${problems.length} problems:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface Manifest {
  /** Path relative to the checkout, for messages and the source hash. */
  path: string;
  json: unknown;
}

const ELEMENT_TYPES = new Set(['web-component', 'custom-element', 'native']);
const ATTRIBUTE_TYPES = new Set(['boolean', 'string', 'number', 'enum']);
/** html-validate's content categories that permittedContent may name. */
const CATEGORIES = new Set(['flow', 'phrasing', 'script', 'heading', 'sectioning', 'interactive', 'embedded', 'metadata', 'form']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Builds a snapshot; throws VocabError listing every problem. */
export function compileSnapshot(manifests: readonly Manifest[], source: Omit<Snapshot['source'], 'files'> & { version: string }): Snapshot {
  const problems: string[] = [];
  const elements: Record<string, VocabElement> = {};
  const origin = new Map<string, string>();

  for (const { path, json } of manifests) {
    // api-overrides.json holds an array of manifests.
    const items = Array.isArray(json) ? json : [json];
    items.forEach((item, index) => {
      const at = Array.isArray(json) ? `${path}[${index}]` : path;
      const problem = (message: string) => problems.push(`${at}: ${message}`);
      if (!isObject(item)) return problem('a manifest must be an object');
      const name = item['element'];
      const type = item['type'];
      if (typeof name !== 'string') return problem('"element" is required');
      if (typeof type !== 'string' || !ELEMENT_TYPES.has(type)) return problem(`<${name}>: "type" must be web-component, custom-element, or native`);
      if (type === 'native' ? !HTML_ELEMENTS.has(name) : !isCustomElementName(name)) {
        return problem(type === 'native' ? `<${name}> isn’t an HTML element` : `<${name}> isn’t a valid custom element name`);
      }
      if (origin.has(name)) return problem(`<${name}> is already declared in ${origin.get(name)}`);
      origin.set(name, at);

      const hv = isObject(item['htmlvalidate']) ? item['htmlvalidate'] : {};
      if (hv['void']) problem(`<${name}> is declared void, but custom elements always have an end tag; declare "permittedContent": [] instead`);
      let permittedContent: string[] | null = null;
      if (hv['permittedContent'] !== undefined) {
        if (!Array.isArray(hv['permittedContent']) || !hv['permittedContent'].every((c) => typeof c === 'string')) {
          problem(`<${name}>: "permittedContent" must be an array of strings`);
        } else {
          permittedContent = hv['permittedContent'] as string[];
          for (const entry of permittedContent) {
            const ok = entry.startsWith('@') ? CATEGORIES.has(entry.slice(1)) : HTML_ELEMENTS.has(entry) || isCustomElementName(entry);
            if (!ok) problem(`<${name}>: permittedContent entry "${entry}" is neither an element nor a known category`);
          }
        }
      }

      const attributes: Record<string, VocabAttribute> = {};
      if (!Array.isArray(item['attributes'])) problem(`<${name}>: "attributes" must be an array`);
      for (const raw of Array.isArray(item['attributes']) ? item['attributes'] : []) {
        const a = attribute(raw, `<${name}>`, problem);
        if (!a) continue;
        if (attributes[a.name]) problem(`<${name}>: attribute "${a.name}" is declared twice`);
        attributes[a.name] = a.spec;
      }

      const childAttributes: VocabChildAttribute[] = [];
      for (const raw of Array.isArray(item['childAttributes']) ? item['childAttributes'] : []) {
        const a = attribute(raw, `<${name}> child attribute`, problem);
        if (!a) continue;
        const on = isObject(raw) ? text(raw['on']) : null;
        if (on === null) problem(`<${name}> child attribute "${a.name}": "on" is required`);
        else childAttributes.push({ ...a.spec, name: a.name, on });
      }

      const structure = (Array.isArray(item['structure']) ? item['structure'] : []).flatMap((s) => {
        if (!isObject(s) || typeof s['element'] !== 'string') {
          problem(`<${name}>: each structure entry needs "element"`);
          return [];
        }
        return [{ element: s['element'], description: text(s['description']) ?? '', required: s['required'] !== false }];
      });

      elements[name] = {
        type: type as VocabElement['type'],
        description: text(item['description']),
        // Elements without html-validate data are taken as flow content with any children.
        flow: hv['flow'] === true || hv['phrasing'] === true || !isObject(item['htmlvalidate']),
        phrasing: hv['phrasing'] === true,
        permittedContent,
        attributes,
        childAttributes,
        structure,
        role: null,
      };
    });
  }
  if (problems.length > 0) throw new VocabError(problems);
  return {
    name: 'vanilla-breeze',
    version: source.version,
    source: { repo: source.repo, commit: source.commit, files: manifests.length, sha256: source.sha256 },
    elements,
  };
}

function attribute(raw: unknown, owner: string, problem: (message: string) => void): { name: string; spec: VocabAttribute } | null {
  if (!isObject(raw) || typeof raw['name'] !== 'string' || raw['name'] === '') {
    problem(`${owner}: each attribute needs "name"`);
    return null;
  }
  const name = raw['name'];
  const type = raw['type'];
  if (type !== undefined && (typeof type !== 'string' || !ATTRIBUTE_TYPES.has(type))) problem(`${owner} attribute "${name}": unknown type ${JSON.stringify(type)}`);
  const values = raw['values'];
  if (type === 'enum' && !(Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string'))) {
    problem(`${owner} attribute "${name}": an enum needs "values", an array of strings`);
  }
  return {
    name,
    spec: {
      kind: text(raw['kind']) ?? 'host-api',
      purpose: text(raw['purpose']),
      direction: text(raw['direction']),
      type: typeof type === 'string' && ATTRIBUTE_TYPES.has(type) ? (type as AttributeType) : null,
      values: type === 'enum' && Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : null,
      default: raw['default'] === undefined || raw['default'] === null ? null : String(raw['default']),
      required: raw['required'] === true,
      public: raw['public'] !== false,
      description: text(raw['description']),
    },
  };
}
