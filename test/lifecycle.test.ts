import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { approveComponent, catalog, checkComponent, checkRegistry, LifecycleError, newComponent, openRegistry, showComponent, withReview } from '../src/assemble/lifecycle.ts';
import { main } from '../src/cli/main.ts';
import { formatComponentCheck, formatRegistryCheck } from '../src/report/text.ts';

/*
 * The component lifecycle (spec §9.10): checks against fixtures with branch
 * coverage, approval, the registry check, the catalog, and scaffolding.
 * Each test builds its registry in a temporary directory.
 */

const ROOT = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'htmlverify-lifecycle-'));
after(() => rmSync(temp, { recursive: true, force: true }));

interface Definition {
  contract?: Record<string, unknown>;
  template: string;
  fixtures?: Record<string, unknown>;
}

let count = 0;
/** A registry directory holding the given components, with their fixtures' data. */
function registryDir(definitions: Record<string, Definition>): string {
  const root = join(temp, `r${count++}`);
  for (const [id, d] of Object.entries(definitions)) {
    const dir = join(root, 'components', id);
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    const contract = { id, version: '1.0.0', summary: 'A test component.', use: 'Tests.', ...d.contract, provenance: { authors: ['htmlverify tests'], aiAssisted: true } };
    writeFileSync(join(dir, 'component.json'), `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(join(dir, 'template.html'), d.template);
    for (const [name, data] of Object.entries(d.fixtures ?? {})) writeFileSync(join(dir, 'fixtures', `${name}.json`), `${JSON.stringify(data)}\n`);
  }
  return root;
}

const NOTE: Definition = {
  contract: {
    params: {
      text: { type: 'text', minLength: 1 },
      tone: { type: 'enum', values: ['info', 'warning'], default: 'info' },
      title: { type: 'text', required: false },
      links: { type: 'list', minItems: 0, maxItems: 3, items: { label: { type: 'text' }, href: { type: 'url' }, current: { type: 'enum', values: ['page'], required: false } } },
    },
  },
  template: '<aside class="note {{tone}}">\n  <template vb-if="title"><strong>{{title}}</strong></template>\n  <p>{{text}}</p>\n  <ul>\n    <template vb-each="links" vb-as="link"><li><a href="{{link.href}}" aria-current="{{link.current}}">{{link.label}}</a></li></template>\n  </ul>\n</aside>',
};
const link = (label: string, current = false) => ({ label, href: `/${label.toLowerCase()}`, ...(current ? { current: 'page' } : {}) });

test('coverage goals: each vb-if both ways, each vb-each by count, optional parameters both ways, every enum value', async () => {
  const root = registryDir({ 'content/note': { ...NOTE, fixtures: { basic: { data: { text: 'Hi.', links: [] } } } } });
  const c = await checkComponent(openRegistry(root), 'content/note');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.coverage.map((g) => `${g.met ? '✓' : '✗'} ${g.goal}`), [
    '✗ vb-if="title" renders (template.html:2:3)',
    '✓ vb-if="title" doesn’t render (template.html:2:3)',
    '✓ vb-each="links" with no items (template.html:5:5)',
    '✗ vb-each="links" with 1 item (template.html:5:5)',
    '✗ vb-each="links" with 2 or more items (template.html:5:5)',
    '✗ tone is given',
    '✓ tone is left out',
    '✓ tone is info',
    '✗ tone is warning',
    '✗ title is given',
    '✓ title is left out',
    '✗ links[].current is given',
    '✗ links[].current is left out',
  ], 'links[].current only fills aria-current, so its values need no fixture each; tone reaches a class token');
});

test('a component with full coverage passes once its expected outputs are written, and approval records the digest', async () => {
  const root = registryDir({ 'content/note': { ...NOTE, fixtures: {
    basic: { data: { text: 'Hi.', links: [] } },
    full: { data: { text: 'Read on.', tone: 'warning', title: 'Note', links: [link('Home'), link('Docs', true)] } },
    one: { data: { text: 'One link.', tone: 'info', links: [link('Home')] } },
  } } });
  const missing = await checkComponent(openRegistry(root), 'content/note');
  assert.equal(missing.status, 'fail');
  assert.ok(missing.coverage.every((g) => g.met));
  assert.match(formatComponentCheck(missing), /✗ fixtures\/basic\.html is missing; run component check --update to write it, then review it/);

  const updated = await checkComponent(openRegistry(root), 'content/note', { update: true });
  assert.equal(updated.status, 'pass');
  assert.deepEqual(updated.written, ['fixtures/basic.html', 'fixtures/full.html', 'fixtures/one.html']);
  const dir = join(root, 'components/content/note');
  assert.equal(readFileSync(join(dir, 'fixtures/full.html'), 'utf8'), [
    '<aside class="note warning">',
    '  <strong>Note</strong>',
    '  <p>Read on.</p>',
    '  <ul>',
    '    <li><a href="/home">Home</a></li>',
    '    <li><a href="/docs" aria-current="page">Docs</a></li>',
    '  </ul>',
    '</aside>',
    '',
  ].join('\n'));
  assert.match(formatComponentCheck(updated), /✓ pass · unreviewed: approve it with htmlverify component approve content\/note --by <name>\n$/);

  const approval = await approveComponent(openRegistry(root), 'content/note', 'A. Reviewer', { date: '2026-10-18' });
  assert.equal(approval.approved, true);
  const contract = JSON.parse(readFileSync(join(dir, 'component.json'), 'utf8'));
  assert.deepEqual(contract.provenance.review, { by: 'A. Reviewer', date: '2026-10-18', digest: updated.digest });
  const registry = openRegistry(root);
  assert.equal(registry.components.get('content/note')?.status, 'reviewed');
  assert.equal((await checkRegistry(registry)).status, 'pass');

  // Any change to the template, the contract, or a fixture makes the approval stale.
  writeFileSync(join(dir, 'template.html'), readFileSync(join(dir, 'template.html'), 'utf8').replace('<p>', '<p class="body">'));
  const changed = openRegistry(root);
  assert.equal(changed.components.get('content/note')?.status, 'stale');
  const gate = await checkRegistry(changed);
  assert.equal(gate.status, 'fail');
  assert.match(formatRegistryCheck(gate), /^content\/note@1\.0\.0 {2}✗ 3 expected outputs missing or different; see htmlverify component check content\/note\n✗ fail · 1 component · 0 approved\n$/);
});

test('a check fails on a fixture that doesn’t assemble or whose output fails strict, and locates the problem in the fixture', async () => {
  const root = registryDir({ 'content/photo': {
    contract: { params: { src: { type: 'url' }, caption: { type: 'text' } } },
    template: '<figure>\n  <img src="{{src}}" />\n  <figcaption>{{caption}}</figcaption>\n</figure>',
    fixtures: { basic: { data: { src: '/a.png', caption: 'A.' } }, typo: { data: { src: '/a.png', captoin: 'A.' } } },
  } });
  const c = await checkComponent(openRegistry(root), 'content/photo', { update: true });
  assert.equal(c.status, 'fail');
  const [basic, typo] = c.fixtures;
  assert.equal(basic!.result.status, 'fail', 'the img has no alt');
  assert.deepEqual(basic!.result.report!.files[0]!.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.origin?.kind} ${f.origin?.plan}`), ['a11y/img-alt component ']);
  assert.deepEqual(typo!.result.plan.findings.map((f) => `${f.line}:${f.column} ${f.message}`), [
    '1:9 /data/caption: "caption" is required (text).',
    '1:35 /data/captoin: "captoin" isn’t a parameter here; did you mean "caption"?',
  ]);
  assert.deepEqual(c.written, [], 'nothing that fails is written as expected output');
  assert.match(formatComponentCheck(c), /✗ fail · 2 fixtures failing\n$/);

  const broken = registryDir({ 'content/broken': { template: '<p>{{missing}}</p>', fixtures: { basic: {} } } });
  const b = await checkComponent(openRegistry(broken), 'content/broken');
  assert.deepEqual(b.problems, [{ file: 'template.html', message: '1:4: {{missing}}: "missing" isn’t declared in component.json.' }]);
  assert.match(formatComponentCheck(b), /^content\/broken\n {2}template\.html: 1:4: \{\{missing\}\}: "missing" isn’t declared in component\.json\.\n✗ fail · 1 file problem\n$/);
});

test('an output that differs from its expected file fails, with the diff', async () => {
  const root = registryDir({ 'content/quote': { contract: { params: { text: { type: 'text' } } }, template: '<blockquote>{{text}}</blockquote>', fixtures: { basic: { data: { text: 'Hi.' } } } } });
  writeFileSync(join(root, 'components/content/quote/fixtures/basic.html'), '<blockquote>Hello.</blockquote>\n');
  const c = await checkComponent(openRegistry(root), 'content/quote');
  assert.equal(c.status, 'fail');
  assert.match(formatComponentCheck(c), /✗ the output differs from fixtures\/basic\.html; if the change is intended, run component check --update and review the diff\n {6}--- a\/fixtures\/basic\.html\n {6}\+\+\+ b\/fixtures\/basic\.html\n {6}@@ -1,1 \+1,1 @@\n {6}-<blockquote>Hello\.<\/blockquote>\n {6}\+<blockquote>Hi\.<\/blockquote>\n/);
});

test('fixture files are checked: valid JSON, only data and slots, key-shaped names, and nothing else in fixtures/', async () => {
  const root = registryDir({ 'content/quote': { contract: { params: { text: { type: 'text' } } }, template: '<blockquote>{{text}}</blockquote>' } });
  const fixtures = join(root, 'components/content/quote/fixtures');
  const none = await checkComponent(openRegistry(root), 'content/quote');
  assert.deepEqual(none.problems, [{ file: 'fixtures/', message: 'has no fixtures; add fixtures/basic.json with the data for one rendering' }]);
  writeFileSync(join(fixtures, 'basic.json'), '{ "data": { "text": "Hi." }, "key": "x" }');
  writeFileSync(join(fixtures, 'Bad Name.json'), '{}');
  writeFileSync(join(fixtures, 'broken.json'), '{ "data": ');
  writeFileSync(join(fixtures, 'orphan.html'), '<blockquote>Hi.</blockquote>\n');
  writeFileSync(join(fixtures, 'notes.txt'), 'todo');
  const c = await checkComponent(openRegistry(root), 'content/quote');
  assert.deepEqual(c.problems.map((p) => `${p.file}: ${p.message.replace(/: .*JSON.*$/, ': …')}`), [
    'fixtures/Bad Name.json: needs a name of lowercase letters, digits, and hyphens, starting with a letter: the name is the instance key the fixture renders under',
    'fixtures/notes.txt: isn’t a fixture; fixtures/ holds <name>.json, the data for one rendering, and <name>.html, its expected output',
    'fixtures/orphan.html: is an expected output with no fixtures/orphan.json to render it',
    'fixtures/basic.json: has "key"; a fixture holds only "data", "slots", and "with"',
    'fixtures/broken.json: isn’t valid JSON: …',
  ]);
});

test('a fixture can render siblings after the component, such as the targets of its refs', async () => {
  const root = registryDir({
    'action/jump': { contract: { context: 'main', params: { label: { type: 'text' }, target: { type: 'ref' } } }, template: '<p><a href="{{target}}">{{label}}</a></p>' },
    'content/section': { contract: { context: 'main', params: { title: { type: 'text' } } }, template: '<section id="@" aria-labelledby="@title">\n  <h2 id="@title" vb-rank>{{title}}</h2>\n</section>' },
  });
  const fixtures = join(root, 'components/action/jump/fixtures');
  writeFileSync(join(fixtures, 'basic.json'), JSON.stringify({ data: { label: 'To the end', target: { ref: 'end' } }, with: [{ use: 'content/section', key: 'end', data: { title: 'The end' } }] }));
  const c = await checkComponent(openRegistry(root), 'action/jump', { update: true });
  assert.equal(c.status, 'pass');
  assert.equal(c.fixtures[0]!.result.html, '<p><a href="#end">To the end</a></p>\n<section id="end" aria-labelledby="end-title">\n  <h2 id="end-title">The end</h2>\n</section>\n');
  writeFileSync(join(fixtures, 'basic.json'), JSON.stringify({ data: { label: 'To the end', target: { ref: 'end' } }, with: [{ use: 'content/section', key: 'end', data: { titel: 'The end' } }] }));
  const typo = await checkComponent(openRegistry(root), 'action/jump');
  assert.deepEqual(typo.fixtures[0]!.result.plan.findings.map((f) => f.message), [
    '/with/0/data/title: "title" is required (text).',
    '/with/0/data/titel: "titel" isn’t a parameter here; did you mean "title"?',
  ], 'findings in a sibling point into the fixture’s "with", in file order');
});

test('fixtures can fill slots, and a page component renders as a page', async () => {
  const root = registryDir({ 'content/section': { contract: { params: { title: { type: 'text' } }, slots: { body: { min: 1 } } }, template: '<section id="@" aria-labelledby="@title">\n  <h2 id="@title" vb-rank>{{title}}</h2>\n  <template vb-slot="body"></template>\n</section>', fixtures: { basic: { data: { title: 'About' }, slots: { body: [{ key: 'text', html: '<p>Text.</p>' }] } } } } });
  const c = await checkComponent(openRegistry(root), 'content/section', { update: true });
  assert.equal(c.status, 'pass');
  assert.equal(c.fixtures[0]!.result.html, '<section id="basic" aria-labelledby="basic-title">\n  <h2 id="basic-title">About</h2>\n  <p>Text.</p>\n</section>\n');

  const pages = join(temp, 'pages');
  cpSync(join(ROOT, 'test/registry'), pages, { recursive: true });
  mkdirSync(join(pages, 'components/page/basic/fixtures'));
  writeFileSync(join(pages, 'components/page/basic/fixtures/basic.json'), JSON.stringify({ data: { title: 'T', description: 'D', heading: 'H' }, slots: { main: [{ key: 'text', html: '<p>Text.</p>' }] } }));
  const page = await checkComponent(openRegistry(pages), 'page/basic', { update: true });
  assert.deepEqual(page.problems, []);
  assert.match(page.fixtures[0]!.result.html!, /^<!doctype html>\n<html lang="en">/);
  assert.deepEqual(page.coverage.filter((g) => !g.met).map((g) => g.goal), ['lang is given']);
});

test('approval requires a clean check with full coverage, and keeps the rest of component.json as written', async () => {
  const root = registryDir({ 'content/note': { ...NOTE, fixtures: { basic: { data: { text: 'Hi.', links: [] } } } } });
  const refused = await approveComponent(openRegistry(root), 'content/note', 'A. Reviewer');
  assert.equal(refused.approved, false);
  assert.equal(JSON.parse(readFileSync(join(root, 'components/content/note/component.json'), 'utf8')).provenance.review, undefined);
  await assert.rejects(approveComponent(openRegistry(root), 'content/note', ' '), LifecycleError);
  await assert.rejects(checkComponent(openRegistry(root), 'content/nite'), /there’s no component content\/nite in .*; did you mean content\/note\?/);

  const review = { by: 'A. Reviewer', date: '2026-10-18', digest: `sha256-${'a'.repeat(64)}` };
  const json = `{ "by": "A. Reviewer", "date": "2026-10-18", "digest": "sha256-${'a'.repeat(64)}" }`;
  assert.equal(withReview('{ "id": "x/y", "provenance": { "authors": ["A"], "aiAssisted": false } }\n', review), `{ "id": "x/y", "provenance": { "authors": ["A"], "aiAssisted": false, "review": ${json} } }\n`);
  assert.equal(withReview('{\n  "provenance": {\n    "authors": ["A"],\n    "aiAssisted": false\n  }\n}\n', review), `{\n  "provenance": {\n    "authors": ["A"],\n    "aiAssisted": false,\n    "review": ${json}\n  }\n}\n`);
  assert.equal(withReview(`{ "provenance": { "authors": ["A"], "aiAssisted": false, "review": { "by": "B", "date": "2025-01-01", "digest": "sha256-${'b'.repeat(64)}" } } }`, review), `{ "provenance": { "authors": ["A"], "aiAssisted": false, "review": ${json} } }`);
});

test('the catalog lists every component on one line, filtered by a query', () => {
  const registry = openRegistry(join(ROOT, 'test/registry'));
  assert.deepEqual(catalog(registry).map((c) => c.line), [
    'action/jump@1      A link to another instance on the page. data: label, target(ref). [unreviewed]',
    'action/submit@1    The button that submits its form. data: label. [unreviewed]',
    'content/prose@1    Paragraphs, lists, and quotes from restricted HTML. data: html(prose). [unreviewed]',
    'content/section@1  A titled section; its heading level comes from where it sits. data: title. slots: body[1..]. [unreviewed]',
    'form/form@1        Form. data: action(url), method?=get|post. slots: fields[1..], actions[1..](action/submit). [unreviewed]',
    'form/text-field@1  Labeled single-line input with an optional hint. data: label, name, type?=text|email|tel|url|search|password, autocomplete?=name|email|tel|organization|off, required?(boolean), hint?(inline). [unreviewed]',
    "nav/primary@1      The site's main navigation. data: label, items[1..](text, href(url), current?=page). [unreviewed]",
    'page/basic@1       A page: head, skip link, header, main with the page heading, and footer. data: lang?(lang), title, description, heading. slots: header(nav/primary), main[1..], footer. [unreviewed]',
  ]);
  assert.deepEqual(catalog(registry, 'FORM').map((c) => c.id), ['action/jump', 'action/submit', 'form/form', 'form/text-field'], 'the query matches IDs, summaries, and uses');
});

test('show gives the contract and an example; new scaffolds a component that checks clean once its output is written', async () => {
  const root = registryDir({});
  assert.deepEqual(newComponent(root, 'content/callout', 'A. Author'), [
    'components/content/callout/component.json',
    'components/content/callout/template.html',
    'components/content/callout/fixtures/basic.json',
    'components/content/callout/README.md',
  ]);
  assert.throws(() => newComponent(root, 'content/callout', 'A. Author'), /components\/content\/callout already exists/);
  assert.throws(() => newComponent(root, 'callout', 'A. Author'), /"callout" isn’t a component ID/);
  assert.equal((await checkComponent(openRegistry(root), 'content/callout', { update: true })).status, 'pass');
  const shown = await showComponent(openRegistry(root), 'content/callout');
  assert.deepEqual(shown.example, { fixture: 'basic', instance: { use: 'content/callout', key: 'basic', data: { text: 'Example text.' } }, html: '<p>Example text.</p>\n' });
  assert.equal(shown.summary.line, 'content/callout@1  One line on what it is. data: text. [unreviewed]');
});

test('the CLI runs the lifecycle on the configured registry', async () => {
  const project = join(temp, 'cli');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'htmlverify.config.json'), JSON.stringify({ registry: 'registry' }));
  mkdirSync(join(project, 'registry'));
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { stdin: (async function* () {})(), stdout: { write: (s: string) => (stdout += s) }, stderr: { write: (s: string) => (stderr += s) }, cwd: project });
    return { code, stdout, stderr };
  };
  assert.equal((await run(['component', 'new', 'content/callout', '--author', 'A. Author'])).code, 0);
  assert.equal((await run(['component', 'check', 'content/callout'])).code, 1);
  assert.equal((await run(['component', 'check', 'content/callout', '--update'])).code, 0);
  const approved = await run(['component', 'approve', 'content/callout', '--by', 'A. Reviewer']);
  assert.equal(approved.code, 0);
  assert.match(approved.stdout, /Approved content\/callout@1\.0\.0: the review is recorded in components\/content\/callout\/component\.json\.\n$/);
  const gate = await run(['registry', 'check']);
  assert.equal(gate.code, 0);
  assert.match(gate.stdout, /^content\/callout@1\.0\.0 {2}✓ reviewed by A\. Reviewer on \d{4}-\d{2}-\d{2}\n✓ pass · 1 component · 1 approved\n$/);
  assert.equal((await run(['catalog', '--query', 'callout'])).stdout, 'content/callout@1  One line on what it is. data: text.\n');
  assert.match((await run(['component', 'show', 'content/callout', '--format', 'json'])).stdout, /"html":"<p>Example text\.<\/p>\\n"/);

  const unknown = await run(['component', 'check', 'content/calout']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^htmlverify: there’s no component content\/calout in .*; did you mean content\/callout\?\n$/);
  assert.equal((await run(['component', 'approve', 'content/callout'])).code, 2, 'approval needs --by');
  assert.equal((await run(['component', 'check', 'content/callout', '--by', 'x'])).code, 2, '--by is approve’s');
  assert.equal((await run(['component', 'remove', 'content/callout'])).code, 2);
  assert.equal((await run(['registry', 'list'])).code, 2);
});
