import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assemble, type AssembleOptions, type AssemblyResult } from '../src/assemble/assemble.ts';
import { parseConfig } from '../src/config.ts';
import { loadComponent, loadRegistry, type Registry } from '../src/assemble/registry.ts';
import { DEFAULT_VOCABULARIES, Vocabulary } from '../src/vocab/vocabulary.ts';

/*
 * Assembly end to end (spec §9.8): plans against test/registry, plus
 * components a test writes into a temporary registry of its own. The contact
 * page is golden: test/assemble/contact.html is its output. Run with
 * UPDATE_GOLDEN=1 to rewrite it, then review the diff.
 */

const DIR = join(import.meta.dirname, 'assemble');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const vocabulary = new Vocabulary(DEFAULT_VOCABULARIES, null, 'x-');
const base = loadRegistry(join(import.meta.dirname, 'registry'), vocabulary);
const temp = mkdtempSync(join(tmpdir(), 'htmlverify-registry-'));
after(() => rmSync(temp, { recursive: true, force: true }));

interface Definition {
  contract?: Record<string, unknown>;
  template: string;
  review?: 'current' | 'outdated';
}

let registries = 0;
/** The test registry plus components written for one test. */
function registryWith(definitions: Record<string, Definition>): Registry {
  const root = join(temp, String(registries++));
  const components = new Map(base.components);
  const problems = [...base.problems];
  for (const [id, d] of Object.entries(definitions)) {
    const dir = join(root, 'components', id);
    mkdirSync(dir, { recursive: true });
    const contract = { id, version: '1.0.0', summary: 'A test component.', use: 'Tests.', ...d.contract, provenance: { authors: ['htmlverify tests'], aiAssisted: false } };
    const write = () => writeFileSync(join(dir, 'component.json'), JSON.stringify(contract, null, 2));
    write();
    writeFileSync(join(dir, 'template.html'), d.template);
    let loaded = loadComponent(dir, id, vocabulary);
    if (d.review && !('problems' in loaded)) {
      const digest = d.review === 'current' ? loaded.digest : `sha256-${'0'.repeat(64)}`;
      contract.provenance = { ...contract.provenance, review: { by: 'A. Reviewer', date: '2026-10-17', digest } } as typeof contract.provenance;
      write();
      loaded = loadComponent(dir, id, vocabulary);
    }
    if ('problems' in loaded) problems.push(...loaded.problems);
    else components.set(id, loaded);
  }
  return { root, components, problems };
}

/** Assembles a plan given as an object, with its JSON text for locations; drafts by default, since the test components are unreviewed. */
function run(plan: unknown, options: Partial<AssembleOptions> = {}): Promise<AssemblyResult> {
  const source = typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2);
  return assemble(JSON.parse(source), { registry: base, planSource: source, draft: true, ...options });
}

/** Plan findings other than review-status warnings, as "rule message". */
const planFindings = (r: AssemblyResult) => r.plan.findings.filter((f) => !/approved, so nobody/.test(f.message)).map((f) => `${f.rule} ${f.message}`);
/** Output findings at error and warning, as "rule kind instance". */
const outFindings = (r: AssemblyResult) =>
  (r.report?.files[0]?.findings ?? []).filter((f) => f.severity !== 'info').map((f) => `${f.rule} ${f.origin?.kind ?? 'none'} ${f.origin?.instance ?? ''}`);

const page = (main: unknown[], slots: Record<string, unknown[]> = {}) =>
  ({ page: { use: 'page/basic', data: { title: 'Test', description: 'A test page.', heading: 'Test' }, slots: { main, ...slots } } });
const prose = (key: string, html: string) => ({ use: 'content/prose', key, data: { html } });
const section = (key: string, title: string, body: unknown[]) => ({ use: 'content/section', key, data: { title }, slots: { body } });
const field = (key: string, data: Record<string, unknown> = {}) => ({ use: 'form/text-field', key, data: { label: 'Name', name: 'name', ...data } });
const form = (key: string, fields: unknown[], actions: unknown[] = [{ use: 'action/submit', key: 'send', data: { label: 'Send' } }]) =>
  ({ use: 'form/form', key, data: { action: '/send' }, slots: { fields, actions } });

test('a plan assembles into the house style, with IDs, ranks, and pruned references', async () => {
  const source = readFileSync(join(DIR, 'contact.plan.json'), 'utf8');
  const r = await run(source);
  assert.equal(r.status, 'pass');
  assert.deepEqual(planFindings(r), []);
  assert.deepEqual(outFindings(r), []);
  if (UPDATE) writeFileSync(join(DIR, 'contact.html'), r.html!);
  assert.equal(r.html, readFileSync(join(DIR, 'contact.html'), 'utf8'));

  const html = r.html!;
  assert.match(html, /<label for="write-contact-email-input">Email<\/label>/, 'IDs come from key paths');
  assert.match(html, /<h2 id="write-title">Write to us<\/h2>/, 'the section ranks below the page heading');
  assert.match(html, /aria-describedby="write-contact-email-hint"/);
  assert.doesNotMatch(html, /write-contact-name-hint/, 'a hint that didn’t render is pruned from aria-describedby');
  assert.match(html, /<a href="#write">Write to us<\/a>/, 'a ref becomes a fragment link');
  assert.match(html, /<output id="write-contact-email-hint" for="write-contact-email-input">We <em>never<\/em> share it\.<\/output>/, 'inline values keep their markup');

  assert.deepEqual(r.components.map((c) => c.id), ['page/basic', 'nav/primary', 'content/prose', 'content/section', 'form/form', 'form/text-field', 'action/submit', 'action/jump']);
  for (const c of r.components) {
    assert.equal(c.version, '1.0.0');
    assert.match(c.digest, /^sha256-[0-9a-f]{64}$/);
  }
  assert.deepEqual(r.gaps, []);
});

test('review status: strict assembles only approved components unless drafting; each is reported once', async () => {
  const plan = page([prose('a', '<p>One.</p>'), prose('b', '<p>Two.</p>')]);
  const strict = await run(plan, { draft: false });
  assert.equal(strict.status, 'fail');
  assert.equal(strict.html, null);
  assert.deepEqual(strict.plan.findings.map((f) => `${f.severity} ${f.message}`), [
    'error /page/use: page/basic@1.0.0 hasn’t been approved; strict assembles only approved components, so have it checked and approved, or assemble with --draft.',
    'error /page/slots/main/0/use: content/prose@1.0.0 hasn’t been approved; strict assembles only approved components, so have it checked and approved, or assemble with --draft.',
  ]);

  for (const options of [{ draft: true }, { draft: false, profile: 'standard' as const }]) {
    const r = await run(plan, options);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.plan.findings.map((f) => f.severity), ['warning', 'warning']);
  }

  const registry = registryWith({
    'test/approved': { contract: { context: 'main' }, template: '<p>Approved.</p>', review: 'current' },
    'test/changed': { contract: { context: 'main' }, template: '<p>Changed.</p>', review: 'outdated' },
  });
  assert.equal(registry.components.get('test/approved')?.status, 'reviewed');
  assert.equal(registry.components.get('test/changed')?.status, 'stale');
  const r = await run(page([{ use: 'test/approved', key: 'a' }, { use: 'test/changed', key: 'b' }]), { registry, draft: false });
  assert.deepEqual(r.plan.findings.filter((f) => !f.message.startsWith('/page/use')).map((f) => f.message), [
    '/page/slots/main/1/use: test/changed@1.0.0 changed since it was approved; strict assembles only approved components, so have it checked and approved, or assemble with --draft.',
  ]);
});

test('assembly/plan: schema errors are located in plan.json, and nothing is assembled', async () => {
  const source = '{\n  "page": {\n    "use": "page/basic",\n    "dat": {},\n    "slots": { "main": "intro" }\n  },\n  "extra": 1\n}\n';
  const r = await run(source);
  assert.equal(r.status, 'fail');
  assert.equal(r.html, null);
  assert.equal(r.report, null);
  assert.deepEqual(r.plan.findings.map((f) => `${f.rule} ${f.line}:${f.column} ${f.message}`), [
    'assembly/plan 4:12 /page/dat: unknown property "dat"; expected "use", "key", "data", "slots".',
    'assembly/plan 5:24 /page/slots/main: must be an array of children.',
    'assembly/plan 7:12 /extra: unknown property "extra"; expected "$schema", "page", "fragment".',
  ]);

  assert.deepEqual(planFindings(await run({ page: { use: 'page/basic' }, fragment: { context: 'main', children: [] } })), [
    'assembly/plan /: a plan has exactly one of "page" and "fragment".',
  ]);

  // Invalid JSON names the bracket that doesn't pair up, when one is the cause.
  const json = async (text: string) => (await assemble(text, { registry: base, draft: true })).plan.findings.map((f) => `${f.line}:${f.column} ${f.message}`);
  assert.deepEqual(await json('{\n  "page": {\n    "use": "page/basic",\n    "slots": { "main": [ { "key": "a", "html": "<p>[a]</p>" } }\n  }\n}\n'), [
    '4:63 /: isn’t valid JSON: Expected \',\' or \']\' after array element; the "}" at 4:63 can’t close the "[" of "main" at 4:24, which needs "]".',
  ]);
  assert.deepEqual(await json('{ "page": { "use": "page/basic", "data": { "title": "\\"}" } }'), ['1:1 /: isn’t valid JSON: Expected \',\' or \'}\' after property value; the "{" at 1:1 is never closed; add its "}".']);
  assert.deepEqual(await json('{ "page": { "use": "page/basic" } } }'), ['1:37 /: isn’t valid JSON: Unexpected non-whitespace character after JSON; the "}" at 1:37 closes nothing, since the brackets before it balance; remove it.']);
  assert.deepEqual(await json('{ "page": { "use": "page/basic",, "data": {} } }'), ['1:33 /: isn’t valid JSON: Expected double-quoted property name.']);
  assert.deepEqual(planFindings(await run({ fragment: { context: 'Main', rank: 9, children: {} } })), [
    'assembly/plan /fragment/context: must be the element the fragment goes in, such as "main" or "tbody".',
    'assembly/plan /fragment/rank: must be the level of the heading the fragment sits under, 0 to 5.',
    'assembly/plan /fragment/children: must be an array of children.',
  ]);
});

test('assembly/key: keys are required, well-formed, and unique among an instance’s children across slots', async () => {
  const r = await run(page([prose('intro', '<p>A.</p>'), { use: 'content/prose', data: { html: '<p>B.</p>' } }, prose('Intro', '<p>C.</p>')], { footer: [prose('intro', '<p>D.</p>')] }));
  assert.deepEqual(planFindings(r), [
    'assembly/key /page/slots/main/1: needs a "key".',
    'assembly/key /page/slots/main/2/key: must be lowercase letters, digits, and hyphens, starting with a letter, such as "contact" or "email-2".',
    'assembly/key /page/slots/footer/0/key: "intro" is already the key of /page/slots/main/0; keys are unique among an instance’s children.',
  ]);
});

test('assembly/component: unknown components and versions, broken ones, and pages out of place', async () => {
  const registry = registryWith({ 'test/broken': { template: '<p>{{missing}}</p>' } });
  const r = await run(page([
    { use: 'form/text-feild', key: 'a' },
    { use: 'content/prose@2', key: 'b', data: { html: '<p>B.</p>' } },
    { use: 'page/basic', key: 'c', data: { lang: 'tlh' } },
    { use: 'test/broken', key: 'd' },
  ]), { registry });
  assert.deepEqual(planFindings(r), [
    'assembly/component /page/slots/main/0/use: there’s no component form/text-feild in the registry; did you mean form/text-field?',
    'assembly/component /page/slots/main/1/use: content/prose@2 isn’t available; the registry has 1.0.0.',
    'assembly/component /page/slots/main/2/use: page/basic is a page component; it goes only at the root of a page plan.',
    'assembly/component /page/slots/main/3/use: test/broken didn’t load: components/test/broken/template.html: 1:4: {{missing}}: "missing" isn’t declared in component.json.',
  ]);
  assert.deepEqual(planFindings(await run({ page: { use: 'content/prose', data: { html: '<p>A.</p>' } } })), [
    'assembly/component /page/use: content/prose isn’t a page component; a page plan starts with one, such as page/basic.',
  ]);
  const pinned = await run(page([{ use: 'content/prose@1', key: 'a', data: { html: '<p>A.</p>' } }, { use: 'content/prose@1.0.0', key: 'b', data: { html: '<p>B.</p>' } }]));
  assert.equal(pinned.status, 'pass');
});

test('assembly/data: parameters are checked against the contract, with their JSON Pointers', async () => {
  const r = await run(page([form('f', [field('a', { label: undefined, name: 'Full Name', required: 'yes' })])]));
  assert.deepEqual(planFindings(r), [
    'assembly/data /page/slots/main/0/slots/fields/0/data/label: "label" is required (text).',
    'assembly/data /page/slots/main/0/slots/fields/0/data/name: must match ^[a-z][a-z0-9_-]*$.',
    'assembly/data /page/slots/main/0/slots/fields/0/data/required: must be true or false.',
  ]);
  const bad = await run(page([{ use: 'form/form', key: 'f', data: { action: 'javascript:alert(1)', method: 'put', target: '_blank' }, slots: { fields: [field('a')], actions: [{ use: 'action/submit', key: 'go', data: { label: 'Go' } }] } }]));
  assert.deepEqual(planFindings(bad), [
    'assembly/data /page/slots/main/0/data/action: uses the javascript: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs.',
    'assembly/data /page/slots/main/0/data/method: "put" isn’t one of "get" or "post".',
    'assembly/data /page/slots/main/0/data/target: "target" isn’t a parameter here.',
  ]);
});

test('assembly/slot: unknown slots, counts, accepted components, and children that don’t fit where the slot is', async () => {
  const registry = registryWith({
    'test/item': { contract: { context: 'ul', params: { text: { type: 'text' } } }, template: '<li>{{text}}</li>' },
    'test/list': { contract: { slots: { items: { max: 2 } } }, template: '<ul><template vb-slot="items"></template></ul>' },
    'test/note': { contract: { slots: { body: {} } }, template: '<p><mark><template vb-slot="body"></template></mark></p>' },
    'test/entry': { contract: { context: 'ul', slots: { body: {} } }, template: '<li><template vb-slot="body"></template></li>' },
  });
  const item = (key: string) => ({ use: 'test/item', key, data: { text: key } });
  const r = await run(page([
    section('empty', 'Empty', []),
    { use: 'test/list', key: 'list', slots: { items: [item('a'), item('b'), { use: 'action/submit', key: 'c', data: { label: 'C' } }] } },
    form('outer', [form('inner', [field('a')])], [{ use: 'action/jump', key: 'j', data: { label: 'J', target: { ref: 'empty' } } }]),
    { use: 'test/note', key: 'note', slots: { body: [prose('p', '<p>Block.</p>')] } },
    { use: 'test/list', key: 'nested', slots: { items: [{ use: 'test/entry', key: 'e', slots: { body: [item('i')] } }] } },
  ], { aside: [] }), { registry });
  assert.deepEqual(planFindings(r), [
    'assembly/slot /page/slots/main/0/slots/body: the slot "body" of content/section needs at least 1 child; it has 0.',
    'assembly/slot /page/slots/main/1/slots/items: the slot "items" of test/list takes at most 2 children; it has 3.',
    'assembly/slot /page/slots/main/1/slots/items/2/use: action/submit doesn’t fit in <ul>: <ul> takes <li>, <script>, or <template>, and its root is <button>.',
    'assembly/slot /page/slots/main/2/slots/fields/0/use: form/form doesn’t fit in <form>: it puts <form> inside <form>, and the parser drops the inner one.',
    'assembly/slot /page/slots/main/2/slots/actions/0/use: the slot "actions" of form/form takes action/submit, not action/jump.',
    'assembly/slot /page/slots/main/3/slots/body/0/use: content/prose doesn’t fit in <mark>: <mark> takes phrasing content, and its root is <layout-stack>.',
    'assembly/slot /page/slots/main/4/slots/items/0/slots/body/0/use: test/item doesn’t fit in <li>: it puts <li> inside <li>, and the parser closes the open <li> first.',
    'assembly/slot /page/slots/aside: page/basic has no slot "aside"; its slots are header, main, footer.',
  ]);
  const fragment = await run({ fragment: { context: 'ul', children: [prose('p', '<p>A.</p>')] } }, { registry });
  assert.deepEqual(planFindings(fragment), [
    'assembly/slot /fragment/children/0/use: content/prose doesn’t fit in <ul>: <ul> takes <li>, <script>, or <template>, and its root is <layout-stack>.',
  ]);
  // A form deeper in a component's template meets the form around the slot all the same.
  const deep = registryWith({ 'test/finder': { template: '<search><form action="/find"><label>Find <input type="search" name="q" /></label></form></search>' } });
  assert.deepEqual(planFindings(await run(page([form('f', [{ use: 'test/finder', key: 'find' }])]), { registry: deep })), [
    'assembly/slot /page/slots/main/0/slots/fields/0/use: test/finder doesn’t fit in <form>: it puts <form> inside <form>, and the parser drops the inner one.',
  ]);
});

test('assembly/ref: refs resolve to instance IDs; missing targets and references to what didn’t render are errors', async () => {
  const jump = (key: string, ref: string) => ({ use: 'action/jump', key, data: { label: `To ${ref}`, target: { ref } } });
  const ok = await run(page([section('write', 'Write', [prose('p', '<p>A.</p>'), section('inner', 'Inner', [prose('q', '<p>B.</p>')])])], { footer: [jump('a', 'write'), jump('b', 'write/inner')] }));
  assert.equal(ok.status, 'pass');
  assert.match(ok.html!, /<a href="#write">To write<\/a><a href="#write-inner">To write\/inner<\/a>/);
  assert.match(ok.html!, /<section id="write-inner" aria-labelledby="write-inner-title">\n\s+<h3 id="write-inner-title">Inner<\/h3>/);

  const missing = await run(page([section('write', 'Write', [prose('p', '<p>A.</p>')]), { key: 'raw', html: '<p>Raw.</p>' }], { footer: [jump('a', 'nope'), jump('b', 'write/p'), jump('c', 'raw')] }));
  assert.equal(missing.status, 'fail');
  assert.deepEqual(planFindings(missing), [
    'assembly/ref /page/slots/footer/0/data/target: { "ref": "nope" } names no instance in the plan; a key path lists keys from the top of the plan down, such as "contact/email".',
    'assembly/ref /page/slots/footer/1/data/target: { "ref": "write/p" } names an instance whose component has no id="@"; refer to one that does.',
    'assembly/ref /page/slots/footer/2/data/target: { "ref": "raw" } names an HTML node; a ref names a component instance whose component has id="@".',
  ]);
  assert.equal(missing.report, null, 'the output isn’t checked until the plan builds cleanly');
  assert.ok(missing.html, 'the output is still there to inspect');

  // A ref can be narrowed to the components it may name.
  const narrowed = registryWith({ 'test/opener': { contract: { context: 'main', params: { target: { type: 'ref', accepts: ['test/box'] } } }, template: '<button type="button" commandfor="{{target}}" command="show-modal">Open</button>' }, 'test/box': { contract: { context: 'main' }, template: '<dialog id="@" aria-label="Box"><p>Inside.</p></dialog>' } });
  const wrong = await run(page([section('write', 'Write', [prose('p', '<p>A.</p>')]), { use: 'test/box', key: 'box' }, { use: 'test/opener', key: 'a', data: { target: { ref: 'write' } } }, { use: 'test/opener', key: 'b', data: { target: { ref: 'box' } } }]), { registry: narrowed });
  assert.deepEqual(planFindings(wrong), ['assembly/ref /page/slots/main/2/data/target: { "ref": "write" } names a content/section; it takes test/box.']);
  assert.match(wrong.html!, /<button type="button" commandfor="box" command="show-modal">Open<\/button>/, 'the ref to an accepted component resolves');

  // On a page, a fragment link from data or prose must land on an ID the page has.
  const fragments = await run(page([section('write', 'Write', [prose('p', '<p>See <a href="#write">above</a> or <a href="#later">later</a>.</p>')])], { header: [{ use: 'nav/primary', key: 'nav', data: { label: 'Main', items: [{ text: 'Write', href: '#write' }, { text: 'Gone', href: '#gone' }, { text: 'Top', href: '#top' }] } }] }));
  assert.deepEqual(planFindings(fragments), [
    'assembly/ref /page/slots/main/0/slots/body/0/data/html: href="#later" matches no id on the page; link to one it has, such as an instance’s ID.',
    'assembly/ref /page/slots/header/0/data/items/1/href: href="#gone" matches no id on the page; link to one it has, such as an instance’s ID.',
  ], 'in plan order: main comes first in this plan');

  const registry = registryWith({
    'test/check': { contract: { params: { label: { type: 'text' }, box: { type: 'boolean', default: false } } }, template: '<label for="@box">{{label}}</label>\n<template vb-if="box"><input id="@box" type="checkbox" /></template>' },
    'test/skip': { contract: { params: { show: { type: 'boolean', default: false } } }, template: '<a href="#@target">Skip</a>\n<template vb-if="show"><p id="@target">Target.</p></template>' },
  });
  const dangling = await run(page([{ use: 'test/check', key: 'c', data: { label: 'Check' } }, { use: 'test/skip', key: 's' }]), { registry });
  assert.deepEqual(planFindings(dangling), [
    'assembly/ref /page/slots/main/0: for="@box" in test/check refers to an element that didn’t render; render it, or make the reference conditional too.',
    'assembly/ref /page/slots/main/1: href="#@target" in test/skip links to an element that didn’t render.',
  ]);
  const rendered = await run(page([{ use: 'test/check', key: 'c', data: { label: 'Check', box: true } }, { use: 'test/skip', key: 's', data: { show: true } }]), { registry });
  assert.equal(rendered.status, 'pass');
  assert.match(rendered.html!, /<label for="c-box">Check<\/label>/);
  assert.match(rendered.html!, /<a href="#s-target">Skip<\/a>/);
});

test('assembly/id-collision: two instances whose key paths make the same ID', async () => {
  const r = await run(page([section('write', 'Write', [prose('p', '<p>A.</p>')]), section('write-title', 'Other', [prose('p', '<p>B.</p>')])]));
  assert.deepEqual(planFindings(r), [
    'assembly/id-collision /page/slots/main/1: id="write-title" appears twice, in write and write-title; change a key.',
  ]);
});

test('assembly/heading-depth: ranks follow nesting, and h6 is the deepest', async () => {
  const nest = (depth: number, inner: unknown[]): unknown[] => (depth === 0 ? inner : [section(`s${depth}`, `Level ${depth}`, nest(depth - 1, inner))]);
  const five = await run(page(nest(5, [prose('p', '<p>Deep.</p>')])));
  assert.equal(five.status, 'pass');
  assert.match(five.html!, /<h6 id="s5-s4-s3-s2-s1-title">Level 1<\/h6>/);

  const six = await run(page(nest(6, [prose('p', '<p>Deeper.</p>')])));
  assert.deepEqual(planFindings(six), [
    'assembly/heading-depth /page/slots/main/0/slots/body/0/slots/body/0/slots/body/0/slots/body/0/slots/body/0: content/section’s heading would be level 7, past <h6>; nest it less deeply.',
  ]);
  const prosed = await run(page(nest(5, [prose('p', '<h2>Too deep</h2><p>Text.</p>')])));
  assert.deepEqual(planFindings(prosed), [
    'assembly/heading-depth /page/slots/main/0/slots/body/0/slots/body/0/slots/body/0/slots/body/0/slots/body/0/data/html: a prose heading would be level 7, past <h6>; nest it less deeply.',
  ]);
  const fragment = await run({ fragment: { context: 'main', rank: 5, children: nest(2, [prose('p', '<p>A.</p>')]) } });
  assert.deepEqual(planFindings(fragment), [
    'assembly/heading-depth /fragment/children/0/slots/body/0: content/section’s heading would be level 7, past <h6>; nest it less deeply, or give the fragment a lower rank.',
  ]);

  const relative = await run(page([section('s', 'Section', [prose('p', '<h3>A</h3><p>a</p><h4>B</h4><p>b</p><h3>C</h3><p>c</p>')])]));
  assert.equal(relative.status, 'pass');
  assert.match(relative.html!, /<h3>A<\/h3>\n\s+<p>a<\/p>\n\s+<h4>B<\/h4>\n\s+<p>b<\/p>\n\s+<h3>C<\/h3>/, 'prose headings start one below the section’s');
});

test('assembly/restricted-html: inline, prose, and HTML-node values are validated where they go, never sanitized', async () => {
  const hint = (key: string, value: string) => field(key, { name: key, hint: value });
  const r = await run(page([form('f', [
    hint('a', 'See <div>this</div>'),
    hint('b', '<a href="javascript:alert(1)">x</a>'),
    hint('c', '<b><i>x</b></i>'),
    hint('d', 'a <!-- c --> b'),
    hint('e', '<em onclick="go()">x</em>'),
    hint('g', '<a href="/ok" class="c">ok</a>'),
  ]), prose('p', '<h2>A</h2><h4>B</h4>')]));
  assert.deepEqual(planFindings(r), [
    'assembly/restricted-html /page/slots/main/0/slots/fields/0/data/hint: 1:5 <div> isn’t allowed in an inline value; it takes <a>, <abbr>, <b>, <bdi>, <br>, <cite>, <code>, <data>, <del>, <dfn>, <em>, <i>, <ins>, <kbd>, <mark>, <q>, <s>, <samp>, <small>, <span>, <strong>, <sub>, <sup>, <time>, <u>, <var>, and <wbr>.',
    'assembly/restricted-html /page/slots/main/0/slots/fields/1/data/hint: 1:4 href="javascript:alert(1)" uses the javascript: scheme; allowed are https:, http:, mailto:, or tel:, relative, and #fragment URLs.',
    'assembly/restricted-html /page/slots/main/0/slots/fields/2/data/hint: 1:4 <i> overlaps </b> at 1:8: the parser closes it there, so </i> at 1:12 matches nothing. Close </i> before </b>. (syntax/misnested).',
    'assembly/restricted-html /page/slots/main/0/slots/fields/3/data/hint: 1:3 Comments aren’t allowed in an inline value.',
    'assembly/restricted-html /page/slots/main/0/slots/fields/4/data/hint: 1:5 onclick isn’t allowed on <em> in an inline value.',
    'assembly/restricted-html /page/slots/main/0/slots/fields/5/data/hint: 1:15 class isn’t allowed on <a> in an inline value; it takes href, hreflang, lang, dir, title.',
    'assembly/restricted-html /page/slots/main/1/data/html: 1:11 <h4> skips a level; prose headings are relative, so start with the highest and go down one at a time.',
  ]);

  const nodes = await run(page([{ key: 'raw', html: '<p>Hand <em>written</em>.</p>' }, { key: 'bad', html: '<script>alert(1)</script><p onclick="go()">x</p>' }]));
  assert.deepEqual(planFindings(nodes), [
    'assembly/restricted-html /page/slots/main/1/html: 1:1 <script> isn’t allowed in an HTML node.',
    'assembly/restricted-html /page/slots/main/1/html: 1:29 onclick isn’t allowed in an HTML node; event handlers belong in scripts.',
  ]);
  // How a value is written is the serializer's business: the house style comes out, and the output check applies it.
  const loose = await run(page([{ key: 'opt', html: '<p><label>Keep me signed in <input type=checkbox name=keep checked></label></p>' }]));
  assert.equal(loose.status, 'pass', planFindings(loose).join('\n'));
  assert.match(loose.html!, /<label>Keep me signed in <input type="checkbox" name="keep" checked="true" \/><\/label>/);
  const good = await run(page([{ key: 'raw', html: '<p>Hand <em>written</em>.</p>' }]));
  assert.equal(good.status, 'pass');
  assert.match(good.html!, /<h1>Test<\/h1>\n\s+<p>Hand <em>written<\/em>\.<\/p>/);
  assert.deepEqual(good.gaps, [{ instance: 'raw', plan: '/page/slots/main/0' }], 'each HTML node is a registry gap');
  assert.deepEqual(planFindings(await run(page([{ key: 'raw', html: '<p>A.</p>' }]), { htmlNodes: false })), [
    'assembly/plan /page/slots/main/0: HTML nodes are turned off in this project; use a component.',
  ]);
});

test('assembly/budget: an instance’s own markup, repetitions included, stays within its budget', async () => {
  const registry = registryWith({ 'test/rows': { contract: { params: { rows: { type: 'list', items: 'text' } }, budget: { elements: 3 } }, template: '<ul>\n  <template vb-each="rows" vb-as="row"><li>{{row}}</li></template>\n</ul>' } });
  assert.equal((await run(page([{ use: 'test/rows', key: 'r', data: { rows: ['a', 'b'] } }]), { registry })).status, 'pass');
  assert.deepEqual(planFindings(await run(page([{ use: 'test/rows', key: 'r', data: { rows: ['a', 'b', 'c'] } }]), { registry })), [
    'assembly/budget /page/slots/main/0: test/rows rendered 4 elements, more than its budget of 3; that usually means too much data, or a component that should be split.',
  ]);
  const relaxed = await run(page([{ use: 'test/rows', key: 'r', data: { rows: ['a', 'b', 'c'] } }]), { registry, config: parseConfig({ rules: { 'assembly/budget': 'warning' } }, 'test.json') });
  assert.equal(relaxed.status, 'pass', 'a project can relax the budget');
  assert.deepEqual(relaxed.plan.findings.filter((f) => f.rule === 'assembly/budget').map((f) => f.severity), ['warning']);
  // Markup in values isn't the component's: text-field's budget of 4 holds with a marked-up hint.
  assert.equal((await run(page([form('f', [field('a', { hint: '<em>Really</em> <strong>soon</strong>.' })])]))).status, 'pass');
});

test('output findings are traced to their origin and classified as plan, component, or composition', async () => {
  const registry = registryWith({
    'test/photo': { contract: { params: { src: { type: 'url' } } }, template: '<img src="{{src}}" />' },
    'test/item': { contract: { context: 'ul', params: { text: { type: 'text' } } }, template: '<li>{{text}}</li>' },
    'test/badge': { contract: { slots: { body: {} } }, template: '<p><layout-badge><template vb-slot="body"></template></layout-badge></p>' },
  });
  const nav = { use: 'nav/primary', key: 'nav', data: { label: 'Main', items: [{ text: 'Click here', href: '/a' }, { text: 'Docs', href: 'https://example.com/docs' }] } };
  const plan = await run(page([prose('p', '<p>A.</p>')], { header: [nav] }), { registry });
  assert.deepEqual(outFindings(plan), ['a11y/link-text plan nav', 'semantic/placeholder-content plan nav'], 'data text and bound attributes are the plan’s');
  const finding = plan.report!.files[0]!.findings.find((f) => f.rule === 'a11y/link-text')!;
  assert.deepEqual(finding.origin, { kind: 'plan', component: 'nav/primary@1.0.0', template: 'template.html:4:11', instance: 'nav', plan: '/page/slots/header/0' });

  const component = await run(page([{ use: 'test/photo', key: 'photo', data: { src: '/a.png' } }]), { registry });
  assert.deepEqual(outFindings(component), ['a11y/img-alt component photo'], 'a defect in the template is the component’s');

  const composition = await run(page([section('s', 'S', [{ use: 'test/item', key: 'i', data: { text: 'Item' } }])]), { registry });
  assert.deepEqual(outFindings(composition), ['content/context composition s/i'], 'a child that doesn’t fit its slot is a composition problem');

  // A <form> start tag closes the <p> it's in, which the pre-check can't see through a custom element; the
  // syntax findings explain the round trip's difference and blame the form.
  const restructured = await run(page([{ use: 'test/badge', key: 'b', slots: { body: [form('f', [field('a')])] } }]), { registry });
  assert.equal(restructured.status, 'fail');
  assert.deepEqual(planFindings(restructured), [], 'the parser’s restructuring isn’t an assembler bug');
  assert.deepEqual(outFindings(restructured), ['syntax/unclosed-element composition b/f', 'syntax/stray-end-tag composition b/f', 'syntax/stray-end-tag composition b/f']);
  const unclosed = restructured.report!.files[0]!.findings[0]!;
  assert.match(unclosed.message, /^<layout-badge> is never closed: the parser closed it at \d+:\d+ when <form> began\./);
  assert.deepEqual(unclosed.origin, { kind: 'composition', component: 'form/form@1.0.0', template: 'template.html:1:1', instance: 'b/f', plan: '/page/slots/main/0/slots/body/0' });
});

test('fragments: a context, a starting rank, and inline content written as built', async () => {
  const two = await run({ fragment: { context: 'main', children: [section('write', 'Write', [prose('p', '<p>A.</p>')])] } });
  assert.equal(two.status, 'pass');
  assert.equal(two.html, '<section id="write" aria-labelledby="write-title">\n  <h2 id="write-title">Write</h2>\n  <layout-stack>\n    <p>A.</p>\n  </layout-stack>\n</section>\n');
  const one = await run({ fragment: { context: 'main', rank: 0, children: [section('write', 'Write', [prose('p', '<p>A.</p>')])] } });
  assert.match(one.html!, /<h1 id="write-title">Write<\/h1>/);

  const registry = registryWith({
    'test/item': { contract: { context: 'ul', params: { text: { type: 'text' } } }, template: '<li>{{text}}</li>' },
    'test/term': { contract: { context: 'p', params: { text: { type: 'text' } } }, template: '<dfn id="@">{{text}}</dfn>' },
  });
  const list = await run({ fragment: { context: 'ul', children: [{ use: 'test/item', key: 'a', data: { text: 'A' } }, { use: 'test/item', key: 'b', data: { text: 'B' } }] } }, { registry });
  assert.equal(list.html, '<li>A</li>\n<li>B</li>\n');

  const inline = await run({ fragment: { context: 'p', children: [
    { use: 'test/term', key: 'term', data: { text: 'Lego model' } },
    { key: 'gloss', html: ' means bricks that fit; see ' },
    { use: 'action/jump', key: 'back', data: { label: 'the definition', target: { ref: 'term' } } },
  ] } }, { registry });
  assert.equal(inline.status, 'pass');
  assert.equal(inline.html, '<dfn id="term">Lego model</dfn> means bricks that fit; see <a href="#term">the definition</a>\n');
});
