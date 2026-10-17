import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError, parseContract } from '../src/assemble/contract.ts';
import { DEFAULT_SCHEMES, validateRecord, type ParamSpec, type Problem } from '../src/assemble/params.ts';

// The example in spec §9.4.
const TEXT_FIELD = {
  id: 'form/text-field',
  version: '1.0.0',
  summary: 'Labeled single-line input with an optional hint.',
  use: 'Single-line text, email, phone, URL, search, or password input. For choices use form/choice-group.',
  context: 'form',
  params: {
    label: { type: 'text', minLength: 1 },
    name: { type: 'text', pattern: '^[a-z][a-z0-9_-]*$' },
    type: { type: 'enum', values: ['text', 'email', 'tel', 'url', 'search', 'password'], default: 'text' },
    autocomplete: { type: 'enum', values: ['name', 'email', 'tel', 'organization', 'street-address', 'postal-code', 'username', 'current-password', 'new-password', 'off'], required: false },
    required: { type: 'boolean', default: false },
    hint: { type: 'inline', required: false },
  },
  slots: {},
  budget: { elements: 4 },
  obligations: ['The label names the expected input.'],
  provenance: { authors: ['Ada'], aiAssisted: true, review: { by: 'Ada', date: '2026-10-20', digest: `sha256-${'0'.repeat(64)}` } },
};

const problems = (raw: unknown): string[] => {
  try {
    parseContract(raw, 'component.json');
    return [];
  } catch (error) {
    assert.ok(error instanceof ContractError);
    return error.problems.map((p) => `${p.pointer}: ${p.message}`);
  }
};

test('the spec’s example contract parses, with required and optional parameters resolved', () => {
  const c = parseContract(TEXT_FIELD, 'component.json');
  assert.equal(c.context, 'form');
  assert.deepEqual(Object.entries(c.params).map(([n, p]) => `${n}:${p.type}:${p.required ? 'required' : 'optional'}`), [
    'label:text:required', 'name:text:required', 'type:enum:optional', 'autocomplete:enum:optional', 'required:boolean:optional', 'hint:inline:optional',
  ]);
  assert.equal(c.params['type']!.default, 'text');
  assert.equal(c.provenance.review?.by, 'Ada');
  assert.equal(parseContract({ ...TEXT_FIELD, context: undefined }, 'c').context, 'body');
});

test('every contract problem is reported at once, with its JSON Pointer', () => {
  assert.deepEqual(problems({
    ...TEXT_FIELD,
    id: 'TextField',
    version: '1.0',
    colour: 'red',
    context: 'nowhere',
    params: {
      Label: { type: 'text' },
      kind: { type: 'emum', values: ['a'] },
      count: { type: 'integer', min: 5, max: 1 },
      code: { type: 'text', pattern: '[' },
      size: { type: 'enum', values: ['s', 's'] },
      flag: { type: 'boolean', required: true, default: false },
      note: { type: 'text', values: ['x'] },
    },
    slots: { fields: { min: -1 }, flag: {} },
    budget: { elements: 0 },
    provenance: { authors: [], aiAssisted: 'yes' },
  }), [
    '/colour: unknown key "colour"',
    '/id: must be a group and a name, such as "form/text-field"',
    '/version: must be a semantic version, such as "1.0.0"',
    '/context: must be "document" or an element name, such as "body", "form", "tbody", or "ul"',
    '/params/Label: "Label" isn’t a valid name: use letters and digits, starting with a lowercase letter, such as "label" or "linkText"',
    '/params/kind/type: must be one of text, inline, prose, url, boolean, enum, integer, datetime, lang, ref, or list; did you mean "enum"?',
    '/params/count/min: must not be greater than "max"',
    '/params/code/pattern: isn’t a valid regular expression: Invalid regular expression: /[/u: Unterminated character class',
    '/params/size/values: lists a value twice',
    '/params/flag/default: a required parameter can’t have a default',
    '/params/note/values: "values" doesn’t apply to a text parameter',
    '/slots/fields/min: must be a non-negative integer',
    '/slots/flag: "flag" is also a parameter; slots and parameters share one namespace',
    '/budget: must be { "elements": n }, a positive integer',
    '/provenance/authors: must be a non-empty array of names',
    '/provenance/aiAssisted: must be true or false',
  ]);
});

const validate = (params: Record<string, Omit<ParamSpec, 'required'> & { required?: boolean }>, data: unknown, schemes = DEFAULT_SCHEMES) => {
  const specs = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { required: true, ...v }])) as Record<string, ParamSpec>;
  const out: Problem[] = [];
  const value = validateRecord(specs, data, '', out, { schemes });
  return { value, problems: out.map((p) => `${p.pointer}: ${p.message}`) };
};

test('data: required, unknown, and defaulted parameters', () => {
  const contract = parseContract(TEXT_FIELD, 'c');
  const ok: Problem[] = [];
  assert.deepEqual(validateRecord(contract.params, { label: 'Email', name: 'email', type: 'email' }, '', ok, { schemes: DEFAULT_SCHEMES }), { label: 'Email', name: 'email', type: 'email', required: false });
  assert.deepEqual(ok, []);
  const bad: Problem[] = [];
  assert.equal(validateRecord(contract.params, { lable: 'Email', name: 'Email', type: 'emial' }, '/page/data', bad, { schemes: DEFAULT_SCHEMES }), undefined);
  assert.deepEqual(bad.map((p) => `${p.pointer}: ${p.message}`), [
    '/page/data/lable: "lable" isn’t a parameter here; did you mean "label"?',
    '/page/data/label: "label" is required (text)',
    '/page/data/name: must match ^[a-z][a-z0-9_-]*$',
    '/page/data/type: "emial" isn’t one of "text", "email", "tel", "url", "search", or "password"; did you mean "email"?',
  ]);
});

test('urls: syntax, schemes, and the tricks that hide javascript:', () => {
  const href = { href: { type: 'url' as const } };
  for (const ok of ['/contact', 'https://example.com/a?b=1#c', '#main', 'mailto:a@example.com', 'tel:+15551234567', '../up', '?q=1']) {
    assert.deepEqual(validate(href, { href: ok }).problems, [], ok);
  }
  assert.deepEqual(validate(href, { href: 'javascript:alert(1)' }).problems, ['/href: uses the javascript: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs']);
  assert.deepEqual(validate(href, { href: 'JaVaScRiPt:alert(1)' }).problems, ['/href: uses the javascript: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs']);
  assert.deepEqual(validate(href, { href: 'jav\tascript:alert(1)' }).problems, ['/href: contains a tab or line break']);
  assert.deepEqual(validate(href, { href: 'data:text/html,<p>' }).problems, ['/href: contains "<", which must be percent-encoded']);
  assert.deepEqual(validate(href, { href: 'data:image/png;base64,AAAA' }).problems, ['/href: uses the data: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs']);
  assert.deepEqual(validate(href, { href: 'data:image/png;base64,AAAA' }, [...DEFAULT_SCHEMES, 'data']).problems, []);
  assert.deepEqual(validate(href, { href: '/a b' }).problems, ['/href: contains a space: encode it as %20']);
  assert.deepEqual(validate(href, { href: ' /a' }).problems, ['/href: must not start or end with spaces']);
});

test('scalar types: integers, dates, language tags, refs, and characters a value can’t hold', () => {
  const params = {
    n: { type: 'integer' as const, min: 1, max: 5 },
    when: { type: 'datetime' as const },
    lang: { type: 'lang' as const },
    target: { type: 'ref' as const },
    label: { type: 'text' as const },
  };
  assert.deepEqual(validate(params, { n: 3, when: '2026-10-17', lang: 'pt-BR', target: { ref: 'contact/email' }, label: 'Tab\there\nnext' }).problems, []);
  assert.deepEqual(validate(params, { n: 9, when: '17/10/2026', lang: 'en_US', target: 'email', label: 'a\u0000b' }).problems, [
    '/n: must be at most 5',
    '/when: isn’t a date or time in HTML’s format, such as 2026-10-17, 14:30, or 2026-10-17T14:30Z',
    '/lang: isn’t a language tag: use "-", not "_" ("en-US")',
    '/target: must be { "ref": "key/path" }, naming another instance by its key path, such as "contact/email"',
    '/label: contains the control character U+0000',
  ]);
  assert.deepEqual(validate({ label: { type: 'text' } }, { label: 'a\r\nb' }).problems, ['/label: contains a carriage return; write line breaks as \\n']);
  assert.deepEqual(validate({ label: { type: 'text' } }, { label: 'a\ud800b' }).problems, ['/label: contains a lone surrogate']);
  assert.deepEqual(validate({ label: { type: 'text' } }, { label: 'a￾b' }).problems, ['/label: contains the noncharacter U+FFFE']);
});

test('lists: bounds, scalar items, and records with defaults', () => {
  const items = {
    items: {
      type: 'list' as const, minItems: 1, maxItems: 3,
      items: { text: { type: 'text', required: true }, href: { type: 'url', required: true }, current: { type: 'boolean', required: false, default: false } } as Record<string, ParamSpec>,
    },
  };
  assert.deepEqual(validate(items, { items: [{ text: 'Home', href: '/' }] }).value, { items: [{ text: 'Home', href: '/', current: false }] });
  assert.deepEqual(validate(items, { items: [] }).problems, ['/items: must have at least 1 item']);
  assert.deepEqual(validate(items, { items: [{ text: 'Home', href: 'javascript:x', curent: true }] }).problems, [
    '/items/0/curent: "curent" isn’t a parameter here; did you mean "current"?',
    '/items/0/href: uses the javascript: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs',
  ]);
  assert.deepEqual(validate({ tags: { type: 'list', items: 'text' } }, { tags: ['a', 7] }).problems, ['/tags/1: must be a string (text)']);
});
