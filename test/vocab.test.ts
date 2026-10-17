import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, parseConfig } from '../src/index.ts';
import { compileSnapshot, VocabError } from '../src/vocab/compile.ts';
import { REQUIRED } from '../src/vocab/overlay.ts';
import { ElementsError, parseElements } from '../src/vocab/project.ts';
import { parseSelector } from '../src/vocab/select.ts';
import { gitCommit, snapshotFromCheckout } from '../src/vocab/source.ts';
import { DEFAULT_VOCABULARIES, loadSnapshot } from '../src/vocab/vocabulary.ts';

const dir = mkdtempSync(join(tmpdir(), 'htmlverify-vocab-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const SOURCE = { version: '1.0.0', repo: 'https://example.invalid/vb', commit: null, sha256: '0' };
const manifest = (json: unknown) => [{ path: 'src/web-components/x/api.json', json }];

test('the snapshot compiler rejects what the vocabulary contract forbids', () => {
  const cases: [unknown, RegExp][] = [
    [{ element: 'toggle-thumb', type: 'custom-element', attributes: [], htmlvalidate: { void: true } }, /always have an end tag/],
    [{ element: 'toggle', type: 'web-component', attributes: [] }, /isn’t a valid custom element name/],
    [{ element: 'blink', type: 'native', attributes: [] }, /isn’t an HTML element/],
    [{ element: 'a-b', type: 'widget', attributes: [] }, /"type" must be/],
    [{ element: 'a-b', type: 'web-component', attributes: [{ name: 'size', kind: 'host-api', type: 'enum' }] }, /an enum needs "values"/],
    [{ element: 'a-b', type: 'web-component', attributes: [], htmlvalidate: { permittedContent: ['@everything'] } }, /neither an element nor a known category/],
    [[{ element: 'a-b', type: 'web-component', attributes: [] }, { element: 'a-b', type: 'web-component', attributes: [] }], /already declared/],
  ];
  for (const [json, error] of cases) {
    assert.throws(() => compileSnapshot(manifest(json), SOURCE), (e: unknown) => e instanceof VocabError && error.test(e.message), JSON.stringify(json));
  }
});

test('the snapshot compiler keeps the checked fields in a stable shape', () => {
  const snapshot = compileSnapshot(manifest({
    element: 'a-b', type: 'web-component', description: 'Demo',
    htmlvalidate: { flow: true, permittedContent: ['@flow'] },
    attributes: [
      { name: 'open', kind: 'host-api', purpose: 'output-state', direction: 'output', type: 'boolean' },
      { name: 'size', kind: 'host-api', purpose: 'config', type: 'enum', values: ['s', 'm'], default: 'm' },
    ],
    childAttributes: [{ name: 'data-step', on: 'li', type: 'number' }],
    structure: [{ element: '<li>', description: 'Steps' }, { element: '<p>', description: 'Note', required: false }],
  }), SOURCE);
  const e = snapshot.elements['a-b']!;
  assert.equal(e.flow, true);
  assert.equal(e.phrasing, false);
  assert.deepEqual(e.attributes['size'], { kind: 'host-api', purpose: 'config', direction: null, type: 'enum', values: ['s', 'm'], default: 'm', required: false, public: true, description: null });
  assert.equal(e.childAttributes[0]?.on, 'li');
  assert.deepEqual(e.structure.map((s) => s.required), [true, false]);
});

test('vocab update reads a checkout without running anything in it', () => {
  const checkout = join(dir, 'vb');
  mkdirSync(join(checkout, 'src/web-components/demo-widget'), { recursive: true });
  mkdirSync(join(checkout, 'src/htmlvalidate'), { recursive: true });
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'vanilla-breeze', version: '9.0.0', repository: { url: 'git+https://github.com/profpowell/vanilla-breeze.git' } }));
  writeFileSync(join(checkout, 'src/web-components/demo-widget/api.json'), JSON.stringify({ element: 'demo-widget', type: 'web-component', attributes: [] }));
  writeFileSync(join(checkout, 'src/htmlvalidate/api-overrides.json'), JSON.stringify([{ element: 'demo-extra', type: 'custom-element', attributes: [] }]));
  writeFileSync(join(checkout, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(checkout, '.git/packed-refs'), `# pack-refs with: peeled\n${'a'.repeat(40)} refs/heads/main\n`);
  const snapshot = snapshotFromCheckout(checkout);
  assert.equal(snapshot.version, '9.0.0');
  assert.equal(snapshot.source.repo, 'https://github.com/profpowell/vanilla-breeze');
  assert.equal(snapshot.source.commit, 'a'.repeat(40));
  assert.equal(snapshot.source.files, 2);
  assert.deepEqual(Object.keys(snapshot.elements).sort(), ['demo-extra', 'demo-widget']);
  writeFileSync(join(checkout, '.git/HEAD'), `${'b'.repeat(40)}\n`);
  assert.equal(gitCommit(checkout), 'b'.repeat(40));
  assert.throws(() => snapshotFromCheckout(dir), /no api\.json manifests/);
});

test('elements.json is the html-validate subset plus role and description', () => {
  const elements = parseElements({
    'app-card': { flow: true, permittedContent: ['@flow'], attributes: { tone: { enum: ['calm', 'loud'], omit: true }, open: { boolean: true }, src: { required: true } }, role: 'region', description: 'A card' },
  }, 'elements.json');
  const card = elements['app-card']!;
  assert.deepEqual(card.attributes['tone']?.values, ['calm', 'loud', '']);
  assert.equal(card.attributes['open']?.type, 'boolean');
  assert.equal(card.attributes['src']?.required, true);
  assert.equal(card.role, 'region');
  const bad: [unknown, RegExp][] = [
    [{ card: {} }, /isn’t a valid custom element name/],
    [{ 'app-card': { void: true } }, /unknown key "void"|always have an end tag/],
    [{ 'app-card': { role: 'widget' } }, /concrete ARIA role/],
    [{ 'app-card': { attributes: { n: { enum: ['/\\d+/'] } } } }, /regular expressions/],
    [{ 'app-card': { attributes: { n: { pattern: 'x' } } } }, /unknown key "pattern"/],
  ];
  for (const [raw, error] of bad) assert.throws(() => parseElements(raw, 'elements.json'), (e: unknown) => e instanceof ElementsError && error.test(e.message), JSON.stringify(raw));
});

test('project elements take part in the component and bloat rules', async () => {
  const elements = parseElements({
    'app-card': { attributes: { tone: { enum: ['calm', 'loud'] }, src: { required: true } }, role: 'region' },
  }, 'elements.json');
  const config = { ...parseConfig({}, 'test'), elements };
  const [file] = (await check({ path: 'p.html', source: '<app-card tone="quiet"><p>Card</p></app-card>', context: 'main' }, { config })).files;
  assert.deepEqual(file!.findings.filter((f) => f.rule.startsWith('component/')).map((f) => f.message), [
    '<app-card> needs a src attribute.',
    'tone="quiet" isn’t a value of tone on <app-card>: use "calm" or "loud".',
  ]);
  // A declared role makes a custom element non-generic.
  const many = Array.from({ length: 25 }, () => '<app-card src="/x"><p>Card</p></app-card>').join('');
  const [bloat] = (await check({ path: 'p.html', source: many, context: 'main' }, { config })).files;
  assert.equal(bloat!.metrics?.generic, 0);
  await assert.rejects(check({ path: 'p.html', source: '', context: 'main' }, { config: { elements: parseElements({ 'layout-stack': {} }, 'elements.json') } }), /already defined by Vanilla Breeze/);
});

test('without a vocabulary the component rules are untested; the ad-hoc prefix can be turned off', async () => {
  const none = parseConfig({ vocabularies: [] }, 'test');
  const [file] = (await check({ path: 'p.html', source: '<layout-stak></layout-stak>', context: 'main' }, { config: none })).files;
  assert.ok(!file!.findings.some((f) => f.rule.startsWith('component/')));
  assert.ok(file!.coverage.untested.some((u) => u.check === 'component/*'));
  const strictPrefix = parseConfig({ options: { adHocPrefix: null } }, 'test');
  const [adHoc] = (await check({ path: 'p.html', source: '<x-panel></x-panel>', context: 'main' }, { config: strictPrefix })).files;
  assert.deepEqual(adHoc!.findings.filter((f) => f.rule === 'component/unknown-element').map((f) => f.severity), ['error']);
});

test('structure requirements parse, name declared elements, and match the manifest text they were written against', () => {
  const snapshot = loadSnapshot(DEFAULT_VOCABULARIES[0]!);
  const basisPath = join(import.meta.dirname, '..', 'data', 'vocab-basis.json');
  const actual: Record<string, string> = {};
  for (const [name, requirements] of Object.entries(REQUIRED).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const element = snapshot.elements[name];
    assert.ok(element, `<${name}> isn’t in ${DEFAULT_VOCABULARIES[0]}`);
    for (const r of requirements) assert.ok(parseSelector(r.selector), `${name}: ${r.selector}`);
    actual[name] = createHash('sha256').update(JSON.stringify([element.structure, element.permittedContent])).digest('hex').slice(0, 16);
  }
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(basisPath, `${JSON.stringify(actual, null, 2)}\n`);
  assert.ok(existsSync(basisPath), 'missing data/vocab-basis.json; run UPDATE_GOLDEN=1 npm test');
  const pinned = JSON.parse(readFileSync(basisPath, 'utf8')) as Record<string, string>;
  const changed = Object.keys({ ...pinned, ...actual }).filter((n) => pinned[n] !== actual[n]);
  assert.deepEqual(changed, [], `manifest structure changed for ${changed.map((n) => `<${n}>`).join(', ')}; review src/vocab/overlay.ts`);
});

test('selectors cover the forms manifests use', () => {
  assert.equal(parseSelector('button | a')?.length, 2);
  assert.equal(parseSelector('main, article, section, aside')?.length, 4);
  assert.deepEqual(parseSelector('input[type=checkbox]')?.[0]?.attrs, [{ name: 'type', value: 'checkbox' }]);
  assert.equal(parseSelector('any child')?.[0]?.tag, null);
  assert.equal(parseSelector('summary > a.topic-name'), null);
});
