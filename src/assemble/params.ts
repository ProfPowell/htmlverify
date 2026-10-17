// Parameter types (spec §9.5): how a contract declares a parameter, and how
// plan data is checked against the declaration. Problems carry JSON Pointers
// into the contract or the data.

import { isTimeValue, languageTagProblem, urlProblem } from '../spec/values.ts';
import { closest, words } from '../text.ts';

export const PARAM_TYPES = ['text', 'inline', 'prose', 'url', 'boolean', 'enum', 'integer', 'datetime', 'lang', 'ref', 'list'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

export interface ParamSpec {
  type: ParamType;
  /** False when the parameter has a default or is declared "required": false. */
  required: boolean;
  default?: Value;
  description?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  values?: string[];
  min?: number;
  max?: number;
  /** A list's items: a scalar type, or a record of fields. */
  items?: ParamType | Record<string, ParamSpec>;
  minItems?: number;
  maxItems?: number;
}

export interface Problem {
  pointer: string;
  message: string;
}

export interface ValueOptions {
  /** Schemes a url value may use, besides relative and fragment URLs. */
  schemes: readonly string[];
}

export const DEFAULT_SCHEMES: readonly string[] = ['https', 'http', 'mailto', 'tel'];

/** Parameter, slot, and record field names. */
export const NAME = /^[a-z][a-zA-Z0-9]*$/;

const COMMON = ['type', 'required', 'default', 'description'];
const KEYS: Record<ParamType, readonly string[]> = {
  text: ['minLength', 'maxLength', 'pattern'],
  inline: [],
  prose: [],
  url: [],
  boolean: [],
  enum: ['values'],
  integer: ['min', 'max'],
  datetime: [],
  lang: [],
  ref: [],
  list: ['items', 'minItems', 'maxItems'],
};

const KEY_PATH = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON Pointer with one more reference token. */
export const at = (pointer: string, token: string | number) => `${pointer}/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;

const count = (s: string) => [...s].length;
const hex = (c: number) => c.toString(16).toUpperCase().padStart(4, '0');
const nonNegativeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Parses a contract's "params" (or a record's fields). */
export function parseParams(raw: unknown, pointer: string, problems: Problem[]): Record<string, ParamSpec> {
  const out: Record<string, ParamSpec> = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    problems.push({ pointer, message: 'must be an object of parameter declarations' });
    return out;
  }
  for (const [name, spec] of Object.entries(raw)) {
    if (!NAME.test(name)) problems.push({ pointer: at(pointer, name), message: `"${name}" isn’t a valid name: use letters and digits, starting with a lowercase letter, such as "label" or "linkText"` });
    const parsed = parseSpec(spec, at(pointer, name), problems);
    if (parsed) out[name] = parsed;
  }
  return out;
}

function parseSpec(raw: unknown, pointer: string, problems: Problem[]): ParamSpec | null {
  const problem = (where: string, message: string) => problems.push({ pointer: where, message });
  if (!isObject(raw)) {
    problem(pointer, 'must be an object with a "type"');
    return null;
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
    const near = typeof type === 'string' ? closest(type, PARAM_TYPES) : null;
    problem(at(pointer, 'type'), `must be one of ${words([...PARAM_TYPES])}${near ? `; did you mean "${near}"?` : ''}`);
    return null;
  }
  const t = type as ParamType;
  const allowed = new Set([...COMMON, ...KEYS[t]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) problem(at(pointer, key), `"${key}" doesn’t apply to a ${t} parameter`);
  }
  const spec: ParamSpec = { type: t, required: true };
  if (raw['description'] !== undefined) {
    if (typeof raw['description'] === 'string') spec.description = raw['description'];
    else problem(at(pointer, 'description'), 'must be a string');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (raw[key] === undefined) continue;
    if (nonNegativeInteger(raw[key])) spec[key] = raw[key];
    else problem(at(pointer, key), 'must be a non-negative integer');
  }
  for (const key of ['min', 'max'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'number' && Number.isInteger(raw[key])) spec[key] = raw[key];
    else problem(at(pointer, key), 'must be an integer');
  }
  for (const [low, high] of [['minLength', 'maxLength'], ['min', 'max'], ['minItems', 'maxItems']] as const) {
    if (spec[low] !== undefined && spec[high] !== undefined && spec[low] > spec[high]) problem(at(pointer, low), `must not be greater than "${high}"`);
  }
  if (raw['pattern'] !== undefined) {
    const pattern = raw['pattern'];
    if (typeof pattern !== 'string') problem(at(pointer, 'pattern'), 'must be a regular expression, as a string');
    else {
      try {
        new RegExp(pattern, 'u');
        spec.pattern = pattern;
      } catch (error) {
        problem(at(pointer, 'pattern'), `isn’t a valid regular expression: ${(error as Error).message}`);
      }
    }
  }
  if (t === 'enum') {
    const values = raw['values'];
    if (!(Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string'))) problem(at(pointer, 'values'), 'must be a non-empty array of strings');
    else if (new Set(values).size !== values.length) problem(at(pointer, 'values'), 'lists a value twice');
    else spec.values = values as string[];
  }
  if (t === 'list') {
    const items = raw['items'];
    if (typeof items === 'string') {
      if (!(PARAM_TYPES as readonly string[]).includes(items) || items === 'list' || items === 'enum') {
        problem(at(pointer, 'items'), 'must be a scalar type other than enum (text, url, boolean, …) or a record of fields; for a list of enums, use a record with one field');
      } else spec.items = items as ParamType;
    } else if (isObject(items) && typeof items['type'] === 'string' && Object.values(items).every((v) => !isObject(v))) {
      // { "type": "text" } reads as a record whose one field is named "type".
      problem(at(pointer, 'items'), `for a list of ${items['type']} values, write "items": "${items['type']}"; a record of fields is { "name": { "type": … }, … }`);
    } else if (isObject(items) && Object.keys(items).length > 0) {
      spec.items = parseParams(items, at(pointer, 'items'), problems);
    } else problem(at(pointer, 'items'), 'must be a type name or a record of field declarations');
  }
  const required = raw['required'];
  if (required !== undefined && typeof required !== 'boolean') problem(at(pointer, 'required'), 'must be true or false');
  if (raw['default'] !== undefined) {
    if (required === true) problem(at(pointer, 'default'), 'a required parameter can’t have a default');
    const value = validateValue({ ...spec, required: true }, raw['default'], at(pointer, 'default'), problems, { schemes: DEFAULT_SCHEMES });
    if (value !== undefined) spec.default = value;
    spec.required = false;
  } else if (required === false) spec.required = false;
  return spec;
}

/** Characters a string value can't hold: controls other than tab and line feed, carriage returns, lone surrogates, noncharacters. */
export function characterProblem(s: string): string | null {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0d) return 'contains a carriage return; write line breaks as \\n';
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) return `contains the control character U+${hex(c)}`;
    if (c >= 0xd800 && c <= 0xdfff) return 'contains a lone surrogate';
    if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return `contains the noncharacter U+${hex(c)}`;
  }
  return null;
}

/**
 * Checks one value against its declaration. Returns the value with record
 * defaults filled in, or undefined when it's invalid; problems are appended.
 */
export function validateValue(spec: ParamSpec, value: unknown, pointer: string, problems: Problem[], options: ValueOptions): Value | undefined {
  const fail = (message: string): undefined => {
    problems.push({ pointer, message });
    return undefined;
  };
  const string = (): string | undefined => {
    if (typeof value !== 'string') return fail(`must be a string (${spec.type})`);
    const bad = characterProblem(value);
    return bad ? fail(bad) : value;
  };
  switch (spec.type) {
    case 'text': {
      const s = string();
      if (s === undefined) return undefined;
      if (spec.minLength !== undefined && count(s) < spec.minLength) return fail(spec.minLength === 1 ? 'must not be empty' : `must be at least ${spec.minLength} characters`);
      if (spec.maxLength !== undefined && count(s) > spec.maxLength) return fail(`must be at most ${spec.maxLength} characters`);
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(s)) return fail(`must match ${spec.pattern}`);
      return s;
    }
    case 'inline':
    case 'prose':
      // The markup is checked where it's inserted (spec §9.5).
      return string();
    case 'url': {
      const s = string();
      if (s === undefined) return undefined;
      if (s.trim() !== s) return fail('must not start or end with spaces');
      const syntax = urlProblem(s, { nonEmpty: true });
      if (syntax) return fail(`${syntax}`);
      const scheme = URL.canParse(s) ? new URL(s).protocol.slice(0, -1) : null;
      if (scheme !== null && !options.schemes.includes(scheme)) {
        return fail(`uses the ${scheme}: scheme; allowed are ${words(options.schemes.map((x) => `${x}:`))}, relative, and #fragment URLs`);
      }
      return s;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : fail('must be true or false');
    case 'enum':
      if (typeof value === 'string' && spec.values!.includes(value)) return value;
      if (typeof value === 'string') {
        const near = closest(value, spec.values!);
        return fail(`"${value}" isn’t one of ${words(spec.values!.map((v) => `"${v}"`))}${near ? `; did you mean "${near}"?` : ''}`);
      }
      return fail(`must be one of ${words(spec.values!.map((v) => `"${v}"`))}`);
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return fail('must be an integer');
      if (spec.min !== undefined && value < spec.min) return fail(`must be at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return fail(`must be at most ${spec.max}`);
      return value;
    case 'datetime': {
      const s = string();
      if (s === undefined) return undefined;
      return isTimeValue(s) ? s : fail('isn’t a date or time in HTML’s format, such as 2026-10-17, 14:30, or 2026-10-17T14:30Z');
    }
    case 'lang': {
      const s = string();
      if (s === undefined) return undefined;
      const problem = languageTagProblem(s);
      return problem ? fail(problem) : s;
    }
    case 'ref':
      if (isObject(value) && Object.keys(value).length === 1 && typeof value['ref'] === 'string' && KEY_PATH.test(value['ref'])) return { ref: value['ref'] };
      return fail('must be { "ref": "key/path" }, naming another instance by its key path, such as "contact/email"');
    case 'list': {
      if (!Array.isArray(value)) return fail('must be an array');
      if (spec.minItems !== undefined && value.length < spec.minItems) return fail(`must have at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return fail(`must have at most ${spec.maxItems} item${spec.maxItems === 1 ? '' : 's'}`);
      const items = spec.items!;
      const out: Value[] = [];
      let ok = true;
      value.forEach((item, i) => {
        const v = typeof items === 'string'
          ? validateValue({ type: items, required: true }, item, at(pointer, i), problems, options)
          : validateRecord(items, item, at(pointer, i), problems, options);
        if (v === undefined) ok = false;
        else out.push(v);
      });
      return ok ? out : undefined;
    }
  }
}

/**
 * Checks an object of named values, such as an instance's data or a list
 * item's fields: unknown names and missing required values are problems, and
 * defaults fill in what's absent. Returns undefined when anything is invalid.
 */
export function validateRecord(params: Record<string, ParamSpec>, value: unknown, pointer: string, problems: Problem[], options: ValueOptions): { [key: string]: Value } | undefined {
  if (value === undefined) value = {};
  if (!isObject(value)) {
    problems.push({ pointer, message: 'must be an object' });
    return undefined;
  }
  const before = problems.length;
  const out: { [key: string]: Value } = {};
  for (const key of Object.keys(value)) {
    if (params[key]) continue;
    const near = closest(key, Object.keys(params));
    problems.push({ pointer: at(pointer, key), message: `"${key}" isn’t a parameter here${near ? `; did you mean "${near}"?` : ''}` });
  }
  for (const [name, spec] of Object.entries(params)) {
    const given = value[name];
    if (given === undefined) {
      if (spec.default !== undefined) out[name] = spec.default;
      else if (spec.required) problems.push({ pointer: at(pointer, name), message: `"${name}" is required (${spec.type})` });
      continue;
    }
    const v = validateValue(spec, given, at(pointer, name), problems, options);
    if (v !== undefined) out[name] = v;
  }
  return problems.length === before ? out : undefined;
}
