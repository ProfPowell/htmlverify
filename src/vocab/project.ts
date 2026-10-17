// The project's own custom elements: <registry>/elements.json (spec §7.4), the
// html-validate subset plus role and description.

import { roleData } from '../spec/aria.ts';
import { isCustomElementName } from '../spec/model.ts';
import type { VocabAttribute, VocabElement } from './types.ts';

export class ElementsError extends Error {}

const ELEMENT_KEYS = new Set(['flow', 'phrasing', 'permittedContent', 'attributes', 'role', 'description']);
const ATTRIBUTE_KEYS = new Set(['required', 'enum', 'boolean', 'omit']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates parsed elements.json; `source` names it in errors. */
export function parseElements(raw: unknown, source: string): Record<string, VocabElement> {
  const fail = (message: string): never => {
    throw new ElementsError(`${source}: ${message}`);
  };
  if (!isObject(raw)) return fail('elements.json must be a JSON object of element definitions');
  const out: Record<string, VocabElement> = {};
  for (const [name, def] of Object.entries(raw)) {
    if (name === '$schema') continue;
    if (!isCustomElementName(name)) fail(`<${name}> isn’t a valid custom element name`);
    if (!isObject(def)) fail(`<${name}> must be an object`);
    const d = def as Record<string, unknown>;
    for (const key of Object.keys(d)) if (!ELEMENT_KEYS.has(key)) fail(`<${name}>: unknown key "${key}"`);
    if (d['void'] !== undefined) fail(`<${name}>: custom elements always have an end tag; declare "permittedContent": [] instead of void`);
    for (const key of ['flow', 'phrasing'] as const) if (d[key] !== undefined && typeof d[key] !== 'boolean') fail(`<${name}>: "${key}" must be true or false`);
    const content = d['permittedContent'];
    if (content !== undefined && !(Array.isArray(content) && content.every((c) => typeof c === 'string'))) fail(`<${name}>: "permittedContent" must be an array of strings`);
    const role = d['role'];
    if (role !== undefined && (typeof role !== 'string' || roleData(role) === null || roleData(role)!.abstract)) fail(`<${name}>: "role" must be a concrete ARIA role, such as "region" or "generic"`);
    if (d['description'] !== undefined && typeof d['description'] !== 'string') fail(`<${name}>: "description" must be a string`);

    const attributes: Record<string, VocabAttribute> = {};
    const attrs = d['attributes'] ?? {};
    if (!isObject(attrs)) fail(`<${name}>: "attributes" must be an object`);
    for (const [attr, spec] of Object.entries(attrs as Record<string, unknown>)) {
      if (!isObject(spec)) fail(`<${name}> attribute "${attr}" must be an object`);
      const s = spec as Record<string, unknown>;
      for (const key of Object.keys(s)) if (!ATTRIBUTE_KEYS.has(key)) fail(`<${name}> attribute "${attr}": unknown key "${key}"`);
      const values = s['enum'];
      if (values !== undefined && !(Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string'))) {
        fail(`<${name}> attribute "${attr}": "enum" must be a non-empty array of strings`);
      }
      if (Array.isArray(values) && values.some((v) => /^\/.*\/$/.test(v as string))) fail(`<${name}> attribute "${attr}": regular expressions in "enum" aren’t supported; list the values`);
      if (s['boolean'] === true && values !== undefined) fail(`<${name}> attribute "${attr}": an attribute is boolean or an enum, not both`);
      attributes[attr] = {
        kind: attr.startsWith('data-') ? 'data' : 'host-api',
        purpose: 'config',
        direction: null,
        type: s['boolean'] === true ? 'boolean' : values !== undefined ? 'enum' : null,
        values: values === undefined ? null : [...(values as string[]), ...(s['omit'] === true ? [''] : [])],
        default: null,
        required: s['required'] === true,
        public: true,
        description: null,
      };
    }
    out[name] = {
      type: 'custom-element',
      description: typeof d['description'] === 'string' ? d['description'] : null,
      flow: d['flow'] !== false || d['phrasing'] === true,
      phrasing: d['phrasing'] === true,
      permittedContent: (content as string[] | undefined) ?? null,
      attributes,
      childAttributes: [],
      structure: [],
      role: typeof role === 'string' && role !== 'generic' ? role : null,
    };
  }
  return out;
}
