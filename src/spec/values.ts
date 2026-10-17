// Attribute value checks, keyed by the value column of the attribute index
// (data/html.json `attributes[].value`), with overrides where an element's
// prose narrows the value. Each check returns null for a valid value, or the
// problem as the rest of a sentence that starts with the attribute.

import type { Element } from '../parse/tree.ts';
import type { Severity } from '../rules/types.ts';
import { HTML, INPUT_TYPES, LINK_TYPES, type AttributeRow } from './data.ts';
import { closest, words } from '../text.ts';
import { attr, has, inputType, isCustomElementName, tokens } from './model.ts';

export interface Problem {
  /** Completes `name="value" …`. */
  text: string;
  severity?: Severity;
}

type Check = (value: string, element: Element, name: string) => Problem | string | null;

const quote = (s: string) => `"${s}"`;
const trimSpaces = (s: string) => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');

// --- Numbers ---------------------------------------------------------------

const INTEGER = /^-?[0-9]+$/;
const NON_NEGATIVE = /^[0-9]+$/;
const FLOAT = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function integer({ min, max }: { min?: number; max?: number } = {}): Check {
  return (value, _element, name) => {
    const pattern = min !== undefined && min >= 0 ? NON_NEGATIVE : INTEGER;
    if (!pattern.test(value)) {
      if ((name === 'width' || name === 'height') && /^[0-9.]+[a-z%]+$/i.test(value)) {
        return 'isn’t a plain number: dimensions are integers of CSS pixels, without units; use CSS for other units';
      }
      return min === 0 ? 'isn’t a non-negative integer' : min === 1 ? 'isn’t an integer greater than zero' : 'isn’t an integer';
    }
    const n = Number(value);
    if (min !== undefined && n < min) return min === 1 ? 'must be greater than zero' : `must be at least ${min}`;
    if (max !== undefined && n > max) return `must be at most ${max}`;
    return null;
  };
}

function float({ above, min }: { above?: number; min?: number } = {}): Check {
  return (value) => {
    if (!FLOAT.test(value)) return /^[0-9.]+%$/.test(value) ? 'isn’t a number: write it without "%"' : 'isn’t a valid floating-point number';
    const n = Number(value);
    if (above !== undefined && !(n > above)) return `must be greater than ${above}`;
    if (min !== undefined && n < min) return `must be at least ${min}`;
    return null;
  };
}

/**
 * <meter> and <progress> numbers in order: value, low, high, and optimum
 * within min and max, low at most high (HTML's inequalities). A missing min
 * or max takes its default; an invalid one is reported on its own.
 */
function ordered(check: Check): Check {
  return (value, element, name) => {
    const problem = check(value, element, name);
    if (problem) return problem;
    const n = Number(value);
    const bound = (a: string, fallback: number | null): { n: number; text: string } | null => {
      const v = attr(element, a);
      if (v === null) return fallback === null ? null : { n: fallback, text: `the default ${a}, ${fallback}` };
      return FLOAT.test(v) ? { n: Number(v), text: `${a} (${v})` } : null;
    };
    const min = name === 'min' || element.tagName === 'progress' ? null : bound('min', 0);
    const max = bound('max', 1);
    const high = name === 'low' ? bound('high', null) : null;
    if (min && n < min.n) return `must be at least ${min.text}`;
    if (high && n > high.n) return `must be at most ${high.text}`;
    if (max && n > max.n) return `must be at most ${max.text}`;
    return null;
  };
}

// --- Tokens and keywords ---------------------------------------------------

function duplicate(list: readonly string[], fold = false): string | null {
  const seen = new Set<string>();
  for (const t of list) {
    const key = fold ? t.toLowerCase() : t;
    if (seen.has(key)) return t;
    seen.add(key);
  }
  return null;
}

const uniqueTokens: Check = (value) => {
  const repeated = duplicate(tokens(value));
  return repeated === null ? null : `repeats ${quote(repeated)}`;
};

function keywords(allowed: readonly string[], { empty = false, caseSensitive = false, hints = {} as Record<string, string> } = {}): Check {
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const set = new Set(allowed.map(fold));
  return (value, _element, name) => {
    if (value === '' && empty) return null;
    if (set.has(fold(value))) return null;
    const near = hints[fold(value)] ?? (value.length >= 3 ? closest(fold(value), allowed.map(fold)) : null);
    if (near) return `isn’t a valid ${name} value. Did you mean ${quote(near)}?`;
    if (allowed.length > 10) return `isn’t a valid ${name} value`;
    return `isn’t a valid ${name} value: use ${words([...allowed.map(quote), ...(empty ? ['the empty string'] : [])])}`;
  };
}

const INPUT_TYPE_HINTS: Record<string, string> = {
  phone: 'tel', telephone: 'tel', mobile: 'tel', mail: 'email', 'e-mail': 'email', datetime: 'datetime-local',
  string: 'text', textarea: 'text', integer: 'number', int: 'number', float: 'number', decimal: 'number',
  link: 'url', uri: 'url', bool: 'checkbox', boolean: 'checkbox', toggle: 'checkbox', select: 'radio',
};

// --- URLs ------------------------------------------------------------------

const BASE = 'https://htmlverify.invalid/dir/page';

interface UrlOptions {
  nonEmpty?: boolean;
  absolute?: boolean;
}

/** URL syntax: what the URL parser would reject, or report as a validation error. */
export function urlProblem(raw: string, { nonEmpty = false, absolute = false }: UrlOptions = {}): string | null {
  const value = trimSpaces(raw);
  if (value === '') return nonEmpty ? 'is empty: give it a URL' : null;
  if (/[\t\n\r]/.test(value)) return 'contains a tab or line break';
  if (value.includes(' ')) return 'contains a space: encode it as %20';
  if (value.includes('\\')) return 'contains a backslash: use "/"';
  const bad = /[\0-\x1f\x7f"<>^`{|}]/.exec(value);
  if (bad) return `contains ${quote(bad[0])}, which must be percent-encoded`;
  if (/%(?![0-9a-fA-F]{2})/.test(value)) return 'has a "%" that isn’t followed by two hex digits: write %25 for a literal "%"';
  if (absolute ? !URL.canParse(value) : !URL.canParse(value, BASE)) return absolute ? 'isn’t a valid absolute URL' : 'isn’t a valid URL';
  return null;
}

const url = (options: UrlOptions = {}): Check => (value) => urlProblem(value, options);

const urls = (options: UrlOptions): Check => (value, element, name) => {
  for (const token of tokens(value)) {
    const problem = urlProblem(token, options);
    if (problem) return `has ${quote(token)}, which ${problem}`;
  }
  return uniqueTokens(value, element, name);
};

// --- Dates and times (HTML §2.3.5) ------------------------------------------

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = '(\\d{4,})';

function isDate(s: string): boolean {
  const m = new RegExp(`^${pad}-(\\d\\d)-(\\d\\d)$`).exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y > 0 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function isMonth(s: string): boolean {
  const m = new RegExp(`^${pad}-(\\d\\d)$`).exec(s);
  return !!m && Number(m[1]) > 0 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

function isYearlessDate(s: string): boolean {
  const m = /^(?:--)?(\d\d)-(\d\d)$/.exec(s);
  return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= daysIn(2000, Number(m[1]));
}

function isTime(s: string): boolean {
  const m = /^(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?$/.exec(s);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59 && (m[3] === undefined || Number(m[3]) <= 59);
}

function isLocalDateTime(s: string): boolean {
  const m = /^(.+?)[T ](.+)$/.exec(s);
  return !!m && isDate(m[1]!) && isTime(m[2]!);
}

function isTimeZoneOffset(s: string): boolean {
  if (s === 'Z') return true;
  const m = /^[+-](\d\d):?(\d\d)$/.exec(s);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

function isGlobalDateTime(s: string): boolean {
  const m = /^(.+?)(Z|[+-]\d\d:?\d\d)$/.exec(s);
  return !!m && isLocalDateTime(m[1]!) && isTimeZoneOffset(m[2]!);
}

function isWeek(s: string): boolean {
  const m = new RegExp(`^${pad}-W(\\d\\d)$`).exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const leap = daysIn(year, 2) === 29;
  const weeks = jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
  return year > 0 && week >= 1 && week <= weeks;
}

function isDuration(s: string): boolean {
  if (/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,3})?S)?)?$/.test(s)) return s !== 'P' && !s.endsWith('T');
  const parts = s.trim().split(/[\t\n\f\r ]+/);
  const scales = new Set<string>();
  for (const part of parts) {
    const m = /^(\d+(?:\.\d{1,3})?)[\t\n\f\r ]*([WwDdHhMmSs])$/.exec(part);
    if (!m) return false;
    const scale = m[2]!.toLowerCase();
    if (scales.has(scale) || (m[1]!.includes('.') && scale !== 's')) return false;
    scales.add(scale);
  }
  return parts.length > 0;
}

/** The forms a <time> element's datetime value (or text) may take. */
export function isTimeValue(s: string): boolean {
  return isMonth(s) || isDate(s) || isYearlessDate(s) || isTime(s) || isLocalDateTime(s) || isTimeZoneOffset(s) ||
    isGlobalDateTime(s) || isWeek(s) || NON_NEGATIVE.test(s) || isDuration(s);
}

const dateCheck = (test: (s: string) => boolean, ...examples: string[]): Check =>
  (value) => (test(value) ? null : `isn’t in the required format, such as ${words(examples.map(quote))}`);

// --- Microsyntaxes -----------------------------------------------------------

// RFC 5646 well-formedness; grandfathered irregular tags listed.
const BCP47 = /^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wyz](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?|x(?:-[a-z0-9]{1,8})+)$/i;
const IRREGULAR = new Set([
  'en-gb-oed', 'i-ami', 'i-bnn', 'i-default', 'i-enochian', 'i-hak', 'i-klingon', 'i-lux', 'i-mingo', 'i-navajo',
  'i-pwn', 'i-tao', 'i-tay', 'i-tsu', 'sgn-be-fr', 'sgn-be-nl', 'sgn-ch-de',
]);

export function languageTagProblem(value: string): string | null {
  if (IRREGULAR.has(value.toLowerCase())) return null;
  if (value.includes('_')) return `isn’t a language tag: use "-", not "_" (${quote(value.replace(/_/g, '-'))})`;
  if (!BCP47.test(value)) return 'isn’t a well-formed BCP 47 language tag, such as "en" or "pt-BR"';
  // No four- to eight-letter primary language subtag is registered.
  if (/^[a-z]{4,8}(?:-|$)/i.test(value)) return 'isn’t a language tag: use a two- or three-letter code, such as "en"';
  return null;
}

const languageTag = ({ empty = false } = {}): Check => (value) => (value === '' && empty ? null : languageTagProblem(value));

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MIME = new RegExp(`^${TOKEN}/${TOKEN}(?:[\\t ]*;[\\t ]*${TOKEN}=(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*"))*$`);
const MIME_NO_PARAMS = new RegExp(`^${TOKEN}/${TOKEN}$`);
const mime: Check = (value) => (MIME.test(value) ? null : 'isn’t a valid MIME type, such as "image/png"');

const JAVASCRIPT_MIME = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

/** A JavaScript MIME type essence match, which makes a classic script. */
export function isJavaScriptMimeType(value: string): boolean {
  return JAVASCRIPT_MIME.has(value.toLowerCase().split(';')[0]!.trim());
}

const scriptType: Check = (value) => {
  const v = value.toLowerCase();
  if (v === 'module' || v === 'importmap' || v === 'speculationrules' || isJavaScriptMimeType(v)) return null;
  if (v === '') return { text: 'is the default: omit type for classic JavaScript', severity: 'warning' };
  return MIME.test(value) ? null : 'isn’t "module", "importmap", "speculationrules", or a valid MIME type for a data block';
};

const accept: Check = (value) => {
  const items = value.split(',').map(trimSpaces);
  for (const item of items) {
    const v = item.toLowerCase();
    if (v === 'audio/*' || v === 'video/*' || v === 'image/*' || v.startsWith('.') || MIME_NO_PARAMS.test(v)) continue;
    return item === '' ? 'has an empty entry' : `has ${quote(item)}, which isn’t a MIME type, "audio/*", "video/*", "image/*", or an extension such as ".pdf"`;
  }
  const repeated = duplicate(items, true);
  return repeated ? `repeats ${quote(repeated)}` : null;
};

const target: Check = (value) => {
  if (/^_(?:blank|self|parent|top)$/i.test(value)) return null;
  if (value === '') return 'is empty: give a navigable name, or "_blank", "_self", "_parent", or "_top"';
  if (value.startsWith('_')) return `isn’t a keyword: use "_blank", "_self", "_parent", or "_top"${/^_new$/i.test(value) ? ' ("_blank" opens a new window)' : ''}`;
  return null;
};

const accesskey: Check = (value) => {
  const keys = tokens(value);
  const long = keys.find((k) => [...k].length !== 1);
  if (long !== undefined) return `has ${quote(long)}: each key must be one character, separated by spaces`;
  const repeated = duplicate(keys);
  return repeated === null ? null : `repeats ${quote(repeated)}`;
};

const command: Check = (value) => {
  if (value.startsWith('--')) return null;
  if (/^(?:toggle-popover|show-popover|hide-popover|close|request-close|show-modal)$/i.test(value)) return null;
  return 'isn’t a command: use "show-modal", "close", "request-close", "toggle-popover", "show-popover", "hide-popover", or a custom command that starts with "--"';
};

const pattern: Check = (value) => {
  try {
    new RegExp(`^(?:${value})$`, 'v');
    return null;
  } catch (error) {
    const reason = (error as Error).message.split(': ').at(-1) ?? '';
    return `isn’t a valid regular expression (with the v flag): ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
  }
};

const sizesOfIcons: Check = (value) => {
  for (const t of tokens(value)) if (!/^(?:any|[1-9][0-9]*[xX][1-9][0-9]*)$/i.test(t)) return `has ${quote(t)}: use "any" or WIDTHxHEIGHT, such as "32x32"`;
  const repeated = duplicate(tokens(value), true);
  return repeated ? `repeats ${quote(repeated)}` : null;
};

/** Image candidates as the srcset parser reads them (HTML "parse a srcset attribute"). */
function srcsetCandidates(input: string): { url: string; descriptors: string[]; strayComma: boolean }[] | null {
  const space = /[\t\n\f\r ]/;
  const out: { url: string; descriptors: string[]; strayComma: boolean }[] = [];
  let i = 0;
  for (;;) {
    let strayComma = false;
    while (i < input.length && (space.test(input[i]!) || input[i] === ',')) {
      if (input[i] === ',') strayComma = true;
      i++;
    }
    if (i >= input.length) return out;
    let url = '';
    while (i < input.length && !space.test(input[i]!)) url += input[i++];
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      const trimmed = url.replace(/,+$/, '');
      if (url.length - trimmed.length > 1) strayComma = true;
      url = trimmed;
    } else {
      let current = '';
      let parens = false;
      while (i < input.length) {
        const c = input[i++]!;
        if (parens) {
          current += c;
          if (c === ')') parens = false;
        } else if (c === ',') break;
        else if (space.test(c)) {
          if (current) descriptors.push(current);
          current = '';
        } else {
          if (c === '(') parens = true;
          current += c;
        }
      }
      if (current) descriptors.push(current);
    }
    out.push({ url, descriptors, strayComma });
  }
}

function srcsetProblem(value: string): string | null {
  const candidates = srcsetCandidates(value) ?? [];
  if (candidates.length === 0) return 'is empty';
  const seen = new Set<string>();
  const widths = candidates.some((c) => c.descriptors.some((d) => /w$/.test(d)));
  for (const { url: source, descriptors, strayComma } of candidates) {
    if (strayComma || source === '') return 'has an empty image candidate (a stray comma)';
    if (descriptors.length > 1) return `gives ${quote(source)} more than one descriptor`;
    const d = descriptors[0] ?? '1x';
    const w = /^([0-9]+)w$/.exec(d);
    const x = /^(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)x$/.exec(d);
    if (!w && !x) return `has ${quote(d)}, which isn’t a width (such as "480w") or a pixel density (such as "2x")`;
    if ((w && Number(w[1]) <= 0) || (x && Number(x[1]) <= 0)) return `has ${quote(d)}, which must be greater than zero`;
    if (widths && !w) return `mixes width descriptors with ${descriptors.length ? quote(d) : `${quote(source)} without one`}: with widths, every candidate needs one`;
    const key = w ? `${Number(w[1])}w` : `${Number(x![1])}x`;
    if (seen.has(key)) return `has two candidates for ${key}`;
    seen.add(key);
    const problem = urlProblem(source, { nonEmpty: true });
    if (problem) return `has ${quote(source)}, which ${problem}`;
  }
  return null;
}

const srcset: Check = (value) => srcsetProblem(value);

/** True when a srcset uses width descriptors, which need sizes. */
export function usesWidthDescriptors(value: string): boolean {
  return (srcsetCandidates(value) ?? []).some((c) => c.descriptors.some((d) => /^[0-9]+w$/.test(d)));
}

const LENGTH = /^(?:0|\+?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:e[+-]?[0-9]+)?(?:px|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|q|in|pt|pc))$/i;

const sizes: Check = (value) => {
  const entries = splitTopLevel(value, ',').map(trimSpaces);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry === '') return 'has an empty entry';
    if (i === 0 && /^auto$/i.test(entry)) continue;
    const [condition, size] = lastComponent(entry);
    if (/%$/.test(size)) return `has ${quote(size)}: percentages aren’t allowed in sizes; use vw`;
    if (!LENGTH.test(size) && !/^(?:calc|min|max|clamp)\(.*\)$/i.test(size)) return `has ${quote(size)}, which isn’t a CSS length such as "100vw" or "480px"`;
    if (condition === '' && i < entries.length - 1) return 'has an entry without a media condition before the last one';
  }
  return null;
};

function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

/** Splits "(media) size" into its media condition and its trailing size value. */
function lastComponent(entry: string): [string, string] {
  if (entry.endsWith(')')) {
    let depth = 0;
    for (let i = entry.length - 1; i >= 0; i--) {
      if (entry[i] === ')') depth++;
      else if (entry[i] === '(' && --depth === 0) {
        let j = i;
        while (j > 0 && /[a-z-]/i.test(entry[j - 1]!)) j--;
        return [entry.slice(0, j).trim(), entry.slice(j)];
      }
    }
  }
  const m = /^(.*?)[\t\n\f\r ]*([^\t\n\f\r ]+)$/.exec(entry);
  return [m?.[1] ?? '', m?.[2] ?? entry];
}

const coords: Check = (value, element) => {
  const shape = (attr(element, 'shape') ?? 'rect').toLowerCase();
  if (shape === 'default') return 'doesn’t apply to shape="default"';
  if (!/^-?[0-9.]+(?:,-?[0-9.]+)*$/.test(value) || value.split(',').some((n) => !FLOAT.test(n))) {
    return 'isn’t a list of numbers separated by commas, without spaces';
  }
  const n = value.split(',').length;
  if ((shape === 'circle' || shape === 'circ') && n !== 3) return 'needs three numbers for a circle: x,y,radius';
  if ((shape === 'rect' || shape === 'rectangle') && n !== 4) return 'needs four numbers for a rectangle: left,top,right,bottom';
  if ((shape === 'poly' || shape === 'polygon') && (n < 6 || n % 2 !== 0)) return 'needs an even number of at least six numbers for a polygon';
  return null;
};

const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** value, min, and max on input, whose syntax depends on the type. */
const byInputType: Check = (value, element, name) => {
  const type = inputType(element);
  if (name === 'value' && value === '') return null;
  switch (type) {
    case 'date': return dateCheck(isDate, '2026-10-17')(value, element, name);
    case 'month': return dateCheck(isMonth, '2026-10')(value, element, name);
    case 'week': return dateCheck(isWeek, '2026-W42')(value, element, name);
    case 'time': return dateCheck(isTime, '14:30')(value, element, name);
    case 'datetime-local': return dateCheck(isLocalDateTime, '2026-10-17T14:30')(value, element, name);
    case 'number':
    case 'range': return float()(value, element, name);
    case 'email': {
      const list = has(element, 'multiple') ? value.split(',').map(trimSpaces) : [value];
      const bad = list.find((e) => !EMAIL.test(e));
      return bad === undefined ? null : `has ${quote(bad)}, which isn’t a valid email address`;
    }
    case 'url': return url({ absolute: true })(value, element, name);
    case 'text':
    case 'search':
    case 'tel':
    case 'password': return /[\n\r]/.test(value) ? 'contains a line break' : null;
    default: return null;
  }
};

// --- Autofill ------------------------------------------------------------------

const AUTOFILL = HTML.autofill;
const FIELDS = new Set(AUTOFILL.fields);
const CONTACT_FIELDS = new Set(AUTOFILL.contactFields);
const CONTACT_TYPES = new Set(AUTOFILL.contactTypes);
const MODES = new Set(AUTOFILL.modes);
const AUTOFILL_HINTS: Record<string, string> = {
  phone: 'tel', telephone: 'tel', mobile: 'tel', 'e-mail': 'email', mail: 'email', zip: 'postal-code', zipcode: 'postal-code',
  postcode: 'postal-code', firstname: 'given-name', 'first-name': 'given-name', fname: 'given-name', lastname: 'family-name',
  'last-name': 'family-name', surname: 'family-name', lname: 'family-name', fullname: 'name', 'full-name': 'name',
  address: 'street-address', city: 'address-level2', state: 'address-level1', province: 'address-level1',
  region: 'address-level1', company: 'organization', birthday: 'bday', password: 'current-password" or "new-password',
  creditcard: 'cc-number', 'credit-card': 'cc-number', cvv: 'cc-csc', cvc: 'cc-csc',
};

const autofill: Check = (value) => {
  const list = tokens(value.toLowerCase());
  if (list.length === 1 && (list[0] === 'on' || list[0] === 'off')) return null;
  if (list.length === 0) return 'is empty: use an autofill field name such as "email", or "on" or "off"';
  let i = 0;
  if (list[i]?.startsWith('section-')) i++;
  if (MODES.has(list[i]!)) i++;
  const field = list[i];
  if (field !== undefined && FIELDS.has(field)) i++;
  else {
    if (CONTACT_TYPES.has(list[i]!)) i++;
    if (list[i] === undefined || !CONTACT_FIELDS.has(list[i]!)) {
      const bad = list[i] ?? list.at(-1)!;
      if (bad === 'on' || bad === 'off') return `can’t combine ${quote(bad)} with other tokens`;
      const hint = AUTOFILL_HINTS[bad] ?? closest(bad, [...FIELDS, ...CONTACT_FIELDS]);
      const suggestion = hint ? `. Did you mean "${hint}"?` : '';
      return list.length === 1 ? `isn’t an autofill field name${suggestion}` : `has ${quote(bad)}, which isn’t an autofill field name${suggestion}`;
    }
    i++;
  }
  if (list[i] === 'webauthn') i++;
  if (i < list.length) return `has ${quote(list[i]!)} out of place: the order is section-*, shipping or billing, the field name, then webauthn`;
  return null;
};

// --- Link types ----------------------------------------------------------------

const rel: Check = (value, element) => {
  const list = tokens(value.toLowerCase());
  const repeated = duplicate(list);
  if (repeated !== null) return `repeats ${quote(repeated)}`;
  const on = element.tagName;
  for (const keyword of list) {
    const type = LINK_TYPES.get(keyword);
    if (!type) continue; // Extensions are registered outside the spec.
    const effect = on === 'link' ? type.link : on === 'form' ? type.form : type.aArea;
    if (effect === null) return `has ${quote(keyword)}, which isn’t allowed on <${on}>`;
  }
  return null;
};

const blocking: Check = (value, element, name) => {
  const bad = tokens(value).find((t) => t !== 'render');
  if (bad !== undefined) return `has ${quote(bad)}: the only blocking token is "render"`;
  return uniqueTokens(value, element, name);
};

const DESTINATIONS = [
  'audio', 'audioworklet', 'document', 'embed', 'fetch', 'font', 'frame', 'iframe', 'image', 'json', 'manifest', 'object',
  'paintworklet', 'report', 'script', 'serviceworker', 'sharedworker', 'style', 'track', 'video', 'webidentity',
  'worker', 'xslt',
];

const SANDBOX_KEYWORDS = HTML.attributes.find((a) => a.name === 'sandbox')?.keywords ?? [];

const sandbox: Check = (value) => {
  const list = tokens(value.toLowerCase());
  const bad = list.find((t) => !SANDBOX_KEYWORDS.includes(t));
  if (bad !== undefined) {
    const near = closest(bad, SANDBOX_KEYWORDS);
    return `has ${quote(bad)}, which isn’t a sandbox keyword${near ? `. Did you mean ${quote(near)}?` : ''}`;
  }
  const repeated = duplicate(list);
  return repeated === null ? null : `repeats ${quote(repeated)}`;
};

const REFERRER_POLICIES = [
  'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin',
  'strict-origin-when-cross-origin', 'unsafe-url',
];

const none: Check = () => null;

/** Checks by value description. Descriptions mapped to `none` are free text or out of scope. */
const BY_VALUE: Record<string, Check> = {
  'Boolean attribute': none, // content/attribute-value for booleans lives in checkBooleanValues.
  'Text': none,
  'Text*': none,
  'Set of space-separated tokens': none,
  'CSS <color>': none,
  'CSS declarations*': none,
  'Serialized permissions policy': none,
  'Valid media query list': none,
  'The source of an iframe srcdoc document*': none,
  'ID*': none, // content/idref
  'Unordered set of unique space-separated tokens consisting of IDs*': uniqueTokens,
  'Unordered set of unique space-separated tokens consisting of valid absolute URLs, defined property names, or text*': uniqueTokens,
  'Unordered set of unique space-separated tokens consisting of valid absolute URLs*': urls({ absolute: true }),
  'Unordered set of unique space-separated tokens*': uniqueTokens,
  'Set of space-separated tokens consisting of valid non-empty URLs': urls({ nonEmpty: true }),
  'Valid non-empty URL potentially surrounded by spaces': url({ nonEmpty: true }),
  'Valid URL potentially surrounded by spaces': url(),
  'Valid non-negative integer greater than zero': integer({ min: 1 }),
  'Valid non-negative integer': integer({ min: 0 }),
  'Valid non-negative integer between 0 and 8': integer({ min: 0, max: 8 }),
  'Valid integer': integer(),
  'Valid floating-point number': float(),
  'Valid floating-point number*': float(),
  'Valid floating-point number greater than zero, or "any"': (v, e, n) => (/^any$/i.test(v) ? null : float({ above: 0 })(v, e, n)),
  'Valid list of floating-point numbers*': coords,
  'Valid navigable target name or keyword': target,
  'Valid BCP 47 language tag': languageTag(),
  'Valid BCP 47 language tag or the empty string': languageTag({ empty: true }),
  'Valid MIME type string': mime,
  'Set of comma-separated tokens* consisting of valid MIME type strings with no parameters or audio/*, video/*, or image/*': accept,
  'ASCII case-insensitive match for "UTF-8"': (v) => (/^utf-8$/i.test(v) ? null : 'must be "UTF-8"'),
  'Ordered set of unique space-separated tokens, none of which are identical to another, each consisting of one code point in length': accesskey,
  'Preload destination, for rel="preload"; module preload destination, for rel="modulepreload"': keywords(DESTINATIONS),
  'Autofill field name and related tokens*': autofill,
  '"toggle-popover"; "show-popover"; "hide-popover"; "close"; "request-close"; "show-modal"; a custom command keyword': command,
  'Valid date string with optional time': dateCheck((s) => isDate(s) || isGlobalDateTime(s), '2026-10-17', '2026-10-17T14:30Z'),
  'Valid month string, valid date string, valid yearless date string, valid time string, valid local date and time string, valid time-zone offset string, valid global date and time string, valid week string, valid non-negative integer, or valid duration string':
    dateCheck(isTimeValue, '2026-10-17', '14:30', 'PT2H'),
  'Valid custom element name of a defined customized built-in element': (v) => (isCustomElementName(v) ? null : 'isn’t a valid custom element name'),
  'Regular expression matching the JavaScript Pattern production': pattern,
  'Referrer policy': keywords(REFERRER_POLICIES, { empty: true }),
  'Unordered set of unique space-separated tokens, ASCII case-insensitive, consisting of sizes*': sizesOfIcons,
  'Valid source size list': sizes,
  'Comma-separated list of image candidate strings': srcset,
  'Valid hash-name reference*': (v) => (/^#.+$/.test(v) ? null : 'must be "#" followed by a map’s name'),
  '"module"; "importmap"; "speculationrules"; a valid MIME type string that is not a JavaScript MIME type essence match': scriptType,
  'input type keyword': keywords([...INPUT_TYPES], { hints: INPUT_TYPE_HINTS }),
  'Varies*': byInputType,
};

/** Element-specific checks that narrow the index's value type. */
const BY_ELEMENT: Record<string, Check> = {
  'td colspan': integer({ min: 1, max: 1000 }),
  'th colspan': integer({ min: 1, max: 1000 }),
  'td rowspan': integer({ min: 0, max: 65534 }),
  'th rowspan': integer({ min: 0, max: 65534 }),
  'progress max': float({ above: 0 }),
  'progress value': ordered(float({ min: 0 })),
  'meter value': ordered(float()),
  'meter min': ordered(float()),
  'meter low': ordered(float()),
  'meter high': ordered(float()),
  'meter optimum': ordered(float()),
  'meta charset': none, // syntax/encoding
  'ol type': keywords(['1', 'a', 'A', 'i', 'I'], { caseSensitive: true }),
  'a rel': rel,
  'area rel': rel,
  'link rel': rel,
  'form rel': rel,
  'link blocking': blocking,
  'script blocking': blocking,
  'style blocking': blocking,
  'iframe sandbox': sandbox,
  'link sizes': sizesOfIcons,
};

/** The problem with an attribute's value, or null; `row` is the attribute index row that defines it. */
export function valueProblem(element: Element, name: string, value: string, row: AttributeRow): Problem | null {
  const check = BY_ELEMENT[`${element.tagName} ${name}`] ?? BY_VALUE[row.value] ?? (row.closed ? keywords(row.keywords, { empty: row.emptyAllowed }) : undefined);
  if (!check) return null;
  const problem = check(value, element, name);
  if (problem === null) return null;
  return typeof problem === 'string' ? { text: problem } : problem;
}

/** Value descriptions with no check, so a spec update that adds one fails a test. */
export function unmappedValueTypes(): string[] {
  const missing = new Set<string>();
  for (const row of HTML.attributes) {
    if (row.closed || BY_VALUE[row.value]) continue;
    if (row.elements.length > 0 && row.elements.every((e) => BY_ELEMENT[`${e} ${row.name}`])) continue;
    missing.add(row.value);
  }
  return [...missing];
}
