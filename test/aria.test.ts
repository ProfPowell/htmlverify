import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Names } from '../src/analysis/names.ts';
import { parseHtml } from '../src/parse/parse.ts';
import { reconcile } from '../src/parse/reconcile.ts';
import { isElement, walk, type Element } from '../src/parse/tree.ts';
import { allowedOnRole, ariaValueProblem, lineage, requiredAttributes, roleData, supportedAttributes } from '../src/spec/aria.ts';
import { CONDITIONAL_ROWS, HTML_ARIA, semanticsOf } from '../src/spec/html-aria.ts';

/*
 * data/html-aria-basis.json pins the text of the ARIA in HTML rows that
 * src/spec/html-aria.ts encodes by hand. Regenerating the data names any row
 * whose text changed: review its encoding, then run UPDATE_GOLDEN=1 npm test.
 */
const BASIS = join(import.meta.dirname, '..', 'data', 'html-aria-basis.json');

test('hand-encoded ARIA in HTML rows match the text they were written against', () => {
  const actual = Object.fromEntries(CONDITIONAL_ROWS.map((id) => {
    const row = HTML_ARIA.rows[id]!;
    return [id, createHash('sha256').update(JSON.stringify([row.element, row.implicit, row.allowances])).digest('hex').slice(0, 16)];
  }).sort(([a], [b]) => (a! < b! ? -1 : 1)));
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(BASIS, `${JSON.stringify(actual, null, 2)}\n`);
  assert.ok(existsSync(BASIS), 'missing data/html-aria-basis.json; run UPDATE_GOLDEN=1 npm test');
  const pinned = JSON.parse(readFileSync(BASIS, 'utf8')) as Record<string, string>;
  const changed = Object.keys({ ...pinned, ...actual }).filter((id) => pinned[id] !== actual[id]);
  assert.deepEqual(changed, [], `ARIA in HTML text changed for ${changed.join(', ')}; review src/spec/html-aria.ts`);
});

test('roles inherit supported and required states from their superclasses', () => {
  assert.ok(lineage('switch').includes('checkbox'));
  assert.ok(requiredAttributes('switch').includes('aria-checked'));
  assert.ok(supportedAttributes('combobox').has('aria-expanded'));
  assert.equal(roleData('img'), roleData('image'), 'img takes its synonym’s characteristics');
  assert.equal(allowedOnRole('aria-label', 'generic'), 'prohibited');
  assert.equal(allowedOnRole('aria-label', 'button'), 'yes');
  assert.equal(allowedOnRole('aria-checked', 'generic'), 'no');
  assert.equal(allowedOnRole('aria-invalid', 'paragraph'), 'deprecated-global');
  assert.equal(allowedOnRole('aria-invalid', 'textbox'), 'yes');
});

test('ARIA value types', () => {
  assert.equal(ariaValueProblem('aria-expanded', 'true'), null);
  assert.match(ariaValueProblem('aria-expanded', 'yes')!, /must be/);
  assert.equal(ariaValueProblem('aria-checked', 'mixed'), null);
  assert.equal(ariaValueProblem('aria-relevant', 'additions text'), null);
  assert.match(ariaValueProblem('aria-relevant', 'everything')!, /space-separated list/);
  assert.equal(ariaValueProblem('aria-level', '2'), null);
  assert.match(ariaValueProblem('aria-level', 'two')!, /integer/);
  assert.match(ariaValueProblem('aria-activedescendant', 'a b')!, /one ID/);
});

function parsed(html: string, context: string | null = 'div') {
  const p = parseHtml(html, context);
  const names = new Names(p.root, p.kind, reconcile(p, html).parentOf, p.context);
  const els = [...walk(p.root)].map((w) => w.node).filter(isElement);
  const find = (selector: (e: Element) => boolean) => els.find(selector)!;
  return { names, find };
}

test('implicit roles depend on context', () => {
  const { names, find } = parsed('<header id="h">Site</header><article><header id="a">Post</header></article><section id="s1">x</section><section id="s2" aria-label="News">y</section><ul><li id="li">x</li></ul><img id="i1" src="a" alt=""><img id="i2" src="a" alt="A">');
  const byId = (id: string) => find((e) => e.attrs.some((a) => a.name === 'id' && a.value === id));
  assert.equal(names.role(byId('h')), 'banner');
  assert.equal(names.role(byId('a')), 'generic');
  assert.equal(names.role(byId('s1')), 'generic');
  assert.equal(names.role(byId('s2')), 'region');
  assert.equal(names.role(byId('li')), 'listitem');
  assert.equal(names.role(byId('i1')), 'none');
  assert.equal(names.role(byId('i2')), 'image');
  assert.equal(semanticsOf(byId('h'), [])?.row, 'el-header');
});

test('accessible names follow the computation order and record their source', () => {
  const { names, find } = parsed([
    '<p id="lbl">Shipping</p><input id="a" aria-labelledby="lbl" aria-label="ignored">',
    '<button id="b" aria-label="Close">×</button>',
    '<label for="c">Email</label><input id="c">',
    '<label>Phone <input id="d"></label>',
    '<a id="e" href="/"><img src="i.png" alt="Home"> page</a>',
    '<input id="f" title="Hint">',
    '<input id="g" placeholder="Search">',
    '<input id="h" type="submit">',
    '<button id="i"><span aria-hidden="true">★</span> Save</button>',
    '<svg id="j"><title>Chart</title></svg>',
    '<fieldset id="k"><legend>Plan</legend></fieldset>',
  ].join(''));
  const name = (id: string) => names.name(find((e) => e.attrs.some((a) => a.name === 'id' && a.value === id)));
  assert.deepEqual(name('a'), { name: 'Shipping', source: 'aria-labelledby' });
  assert.deepEqual(name('b'), { name: 'Close', source: 'aria-label' });
  assert.deepEqual(name('c'), { name: 'Email', source: 'label' });
  assert.deepEqual(name('d'), { name: 'Phone', source: 'label' });
  assert.deepEqual(name('e'), { name: 'Home page', source: 'contents' });
  assert.deepEqual(name('f'), { name: 'Hint', source: 'title' });
  assert.deepEqual(name('g'), { name: 'Search', source: 'placeholder' });
  assert.deepEqual(name('h'), { name: 'Submit', source: 'default' });
  assert.deepEqual(name('i'), { name: 'Save', source: 'contents' });
  assert.deepEqual(name('j'), { name: 'Chart', source: 'svg title' });
  assert.deepEqual(name('k'), { name: 'Plan', source: 'legend' });
});

test('a hidden aria-labelledby target still names, hidden content doesn’t', () => {
  const { names, find } = parsed('<span id="t" hidden="">Secret label</span><button id="b" aria-labelledby="t"></button><button id="c"><span hidden="">Gone</span></button>');
  const name = (id: string) => names.name(find((e) => e.attrs.some((a) => a.name === 'id' && a.value === id))).name;
  assert.equal(name('b'), 'Secret label');
  assert.equal(name('c'), '');
});
