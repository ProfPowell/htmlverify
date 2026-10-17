import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assemble, type AssemblyResult } from '../src/assemble/assemble.ts';
import { jsonPointers } from '../src/assemble/jsonpos.ts';
import { LineIndex } from '../src/parse/lines.ts';
import { parseHtml } from '../src/parse/parse.ts';
import { childrenOf, isElement, isText, walk, type Element, type Node } from '../src/parse/tree.ts';

/*
 * The injection corpus (spec §12.3): hostile values for text, url, inline,
 * and prose parameters. Each one either fails with an error located at its
 * value in the plan, or renders inside its sink and nowhere else: the output
 * has the same elements and attributes as with a benign value, and the value
 * reads back exactly.
 */

const ROOT = join(import.meta.dirname, '..');
const registry = mkdtempSync(join(tmpdir(), 'htmlverify-injection-'));
after(() => rmSync(registry, { recursive: true, force: true }));
cpSync(join(ROOT, 'test/registry'), registry, { recursive: true });
const dir = join(registry, 'components/test/sinks');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'component.json'), JSON.stringify({
  id: 'test/sinks', version: '1.0.0', summary: 'Every kind of sink.', use: 'The injection corpus.',
  params: { title: { type: 'text' }, label: { type: 'text' }, link: { type: 'url' }, notes: { type: 'text' }, hint: { type: 'inline' }, body: { type: 'prose' } },
  provenance: { authors: ['htmlverify tests'], aiAssisted: true },
}));
writeFileSync(join(dir, 'template.html'), `<section id="@" aria-labelledby="@title">
  <h2 id="@title" vb-rank>{{title}}</h2>
  <a href="{{link}}" aria-label="{{label}}">Go</a>
  <label for="@notes">Notes</label>
  <textarea id="@notes" name="notes">{{notes}}</textarea>
  <p>{{hint}}</p>
  <layout-stack>{{body}}</layout-stack>
</section>`);

const BENIGN = { title: 'Title', label: 'Label', link: '/go', notes: 'Notes', hint: 'Hint', body: '<p>Body</p>' };
type Param = keyof typeof BENIGN;

/** Assembles the sinks with one value replaced, in the house style, inside a page. */
async function withValue(param: Param, value: string): Promise<{ result: AssemblyResult; source: string; pointer: string }> {
  const plan = { page: { use: 'page/basic', data: { title: 'Sinks', description: 'Every kind of sink.', heading: 'Sinks' }, slots: { main: [{ use: 'test/sinks', key: 's', data: { ...BENIGN, [param]: value } }] } } };
  const source = JSON.stringify(plan, null, 2);
  return { result: await assemble(source, { registry, draft: true }), source, pointer: `/page/slots/main/0/data/${param}` };
}

/** Elements and their attribute names in document order: what a value must not change. */
function shape(html: string): string {
  return [...walk(parseHtml(html, null).root)].map(({ node }) => node).filter(isElement).map((e) => `${e.tagName}[${e.attrs.map((a) => a.name).join(' ')}]`).join(' ');
}

function textOf(node: Node): string {
  return isText(node) ? node.value : childrenOf(node).map(textOf).join('');
}

function elementsOf(node: Node): Element[] {
  return [...walk(node)].map(({ node: n }) => n).filter(isElement);
}

/** What each sink holds in the parsed output: the section's heading, link, and textarea, and the page title. */
function sinks(html: string) {
  const elements = elementsOf(parseHtml(html, null).root);
  const inside = elementsOf(elements.find((e) => e.tagName === 'section')!);
  const first = (tag: string) => inside.find((e) => e.tagName === tag)!;
  const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)!.value;
  return {
    title: textOf(first('h2')),
    label: attr(first('a'), 'aria-label'),
    link: attr(first('a'), 'href'),
    notes: textOf(first('textarea')),
    page: textOf(elements.find((e) => e.tagName === 'title')!),
  };
}

/** Asserts the value failed with an error at its own place in the plan. */
function rejected(r: { result: AssemblyResult; source: string; pointer: string }, rule: string, message: RegExp) {
  assert.equal(r.result.status, 'fail');
  const finding = r.result.plan.findings.find((f) => f.severity === 'error');
  assert.ok(finding, 'an error');
  assert.equal(finding.rule, rule);
  assert.match(finding.message, message);
  assert.ok(finding.message.startsWith(`${r.pointer}:`), `located at ${r.pointer}: ${finding.message}`);
  const at = new LineIndex(r.source).position(jsonPointers(r.source)!.get(r.pointer)!);
  assert.deepEqual([finding.line, finding.column], [at.line, at.column], 'line and column of the value');
  assert.equal(r.result.html, null, 'nothing is built from invalid data');
}

test('the benign rendering passes, and every sink reads back its value', async () => {
  const { result } = await withValue('title', BENIGN.title);
  assert.equal(result.status, 'pass');
  assert.deepEqual(sinks(result.html!), { title: 'Title', label: 'Label', link: '/go', notes: 'Notes', page: 'Sinks' });
});

test('text values stay text in elements, attributes, and RCDATA', async () => {
  const benign = shape((await withValue('title', BENIGN.title)).result.html!);
  const payloads = ['</title><script>alert(1)</script>', '" onfocus="alert(1)', "' onfocus='alert(1)", '&amp; &lt;b&gt;', '<b>bold</b>', '</textarea><script>alert(1)</script>', 'a\u00A0b', '{{title}}', '<!-- x -->'];
  for (const value of payloads) {
    for (const param of ['title', 'label', 'notes'] as const) {
      const { result } = await withValue(param, value);
      assert.ok(result.html, `${param} ${JSON.stringify(value)} builds`);
      assert.equal(shape(result.html), benign, `${param} ${JSON.stringify(value)} adds no element or attribute`);
      assert.equal(sinks(result.html)[param], value, `${param} ${JSON.stringify(value)} reads back exactly`);
    }
  }
  // The page title is RCDATA too.
  const plan = { page: { use: 'page/basic', data: { title: '</title><script>alert(1)</script>', description: 'D', heading: 'H' }, slots: { main: [{ key: 'p', html: '<p>Text.</p>' }] } } };
  const page = await assemble(JSON.stringify(plan), { registry, draft: true });
  assert.match(page.html!, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  assert.equal(textOf(elementsOf(parseHtml(page.html!, null).root).find((e) => e.tagName === 'title')!), '</title><script>alert(1)</script>');
});

test('text values with control characters, carriage returns, bidi controls, or padding fail where they are', async () => {
  rejected(await withValue('title', 'a\u0000b'), 'assembly/data', /contains the control character U\+0000/);
  rejected(await withValue('label', 'a\r\nb'), 'assembly/data', /contains a carriage return; write line breaks as \\n/);
  rejected(await withValue('notes', 'a\u202Eb'), 'assembly/data', /contains the bidirectional control U\+202E; mark direction with dir or <bdi> instead/);
  rejected(await withValue('title', 'a\u2066b\u2069'), 'assembly/data', /bidirectional control U\+2066/);
  rejected(await withValue('title', ' '), 'assembly/data', /is only whitespace/);
  rejected(await withValue('label', ' Label'), 'assembly/data', /must not start or end with whitespace/);
  rejected(await withValue('title', 'a\uD800b'), 'assembly/data', /lone surrogate/);
  rejected(await withValue('title', 'a\uFFFFb'), 'assembly/data', /noncharacter U\+FFFF/);
});

test('url values: script and data schemes fail however they are spelled; the rest stay in href', async () => {
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav\tascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
    rejected(await withValue('link', value), 'assembly/data', /scheme|tab or line break|must be percent-encoded/);
  }
  rejected(await withValue('link', '" onfocus="alert(1)'), 'assembly/data', /space/);
  rejected(await withValue('link', '#'), 'assembly/data', /links nowhere/);
  rejected(await withValue('link', ' /go'), 'assembly/data', /must not start or end with spaces/);
  rejected(await withValue('link', '?q="x"'), 'assembly/data', /must be percent-encoded/);

  const benign = shape((await withValue('link', BENIGN.link)).result.html!);
  // An entity spelled out in JSON is text, not a tab: the href is a harmless relative path.
  for (const value of ['jav&#x09;ascript:alert(1)', '/search?q=a&b=c', '/a%20b', '//cdn.example.org/x', 'mailto:a@example.org', '?q=%22x%22']) {
    const { result } = await withValue('link', value);
    assert.ok(result.html, `${JSON.stringify(value)} builds`);
    assert.equal(shape(result.html), benign, `${JSON.stringify(value)} adds no element or attribute`);
    const href = sinks(result.html).link;
    assert.equal(href, value, `${JSON.stringify(value)} reads back exactly`);
    assert.notEqual(new URL(href, 'https://site.example/page').protocol, 'javascript:');
  }
});

test('inline and prose values: markup outside the allowlist, scripts, handlers, and repairs fail; allowed markup renders as written', async () => {
  const inline: [string, RegExp][] = [
    ['<script>alert(1)</script>', /<script> isn’t allowed in an inline value/],
    ['<img src="x" onerror="alert(1)" />', /<img> isn’t allowed in an inline value/],
    ['<a href="javascript:alert(1)">x</a>', /uses the javascript: scheme/],
    ['</p><script>alert(1)</script>', /isn’t allowed|matches nothing/],
    ['<b onclick="go()">b</b>', /onclick isn’t allowed on <b>/],
    ['a <!-- c --> b', /Comments aren’t allowed in an inline value/],
    ['<em>open', /never closed/],
    ['<span style="color: red">x</span>', /style isn’t allowed on <span>/],
    ['a\u0000b', /control character U\+0000/],
  ];
  for (const [value, message] of inline) {
    const r = await withValue('hint', value);
    assert.equal(r.result.status, 'fail', JSON.stringify(value));
    assert.ok(['assembly/data', 'assembly/restricted-html'].includes(r.result.plan.findings.find((f) => f.severity === 'error')!.rule));
    assert.match(r.result.plan.findings.map((f) => f.message).join('\n'), message, JSON.stringify(value));
    assert.ok(r.result.plan.findings.filter((f) => f.severity === 'error').every((f) => f.message.startsWith(`${r.pointer}:`)), `${JSON.stringify(value)} is located at its value`);
  }
  const prose: [string, RegExp][] = [
    ['<p>a</p><script>alert(1)</script>', /<script> isn’t allowed in a prose value/],
    ['<p>a</p><style>p { color: red }</style>', /<style> isn’t allowed/],
    ['<div>x</div>', /<div> isn’t allowed in a prose value/],
    ['<h2>A</h2><p onmouseover="go()">b</p>', /onmouseover isn’t allowed on <p>/],
    ['<p><a href="data:text/html,x">x</a></p>', /uses the data: scheme/],
    ['<h2>A</h2><h4>B</h4>', /skips a level/],
  ];
  for (const [value, message] of prose) {
    const r = await withValue('body', value);
    assert.equal(r.result.status, 'fail', JSON.stringify(value));
    assert.match(r.result.plan.findings.map((f) => f.message).join('\n'), message, JSON.stringify(value));
    assert.ok(r.result.plan.findings.filter((f) => f.severity === 'error').every((f) => f.message.startsWith(`${r.pointer}:`)), `${JSON.stringify(value)} is located at its value`);
  }

  const ok = await withValue('hint', 'We <em>never</em> share it &amp; that&#x27;s that.');
  assert.equal(ok.result.status, 'pass');
  assert.match(ok.result.html!, /<p>We <em>never<\/em> share it &amp; that's that\.<\/p>/, 'references are decoded once and the text re-escaped');
  const body = await withValue('body', '<h3>Steps</h3><ol><li>One</li><li>Two</li></ol>');
  assert.equal(body.result.status, 'pass');
  assert.match(body.result.html!, /<layout-stack>\n\s+<h3>Steps<\/h3>\n\s+<ol>\n\s+<li>One<\/li>\n\s+<li>Two<\/li>\n\s+<\/ol>\n\s+<\/layout-stack>/, 'prose headings rank below the section’s h2');
});
