import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import { compareTrees } from '../src/assemble/roundtrip.ts';
import { serialize, type SerializeOptions } from '../src/assemble/serialize.ts';
import { check } from '../src/index.ts';
import { decodeUtf8 } from '../src/parse/decode.ts';
import { parseHtml } from '../src/parse/parse.ts';
import { vocabularyBooleans } from '../src/vocab/booleans.ts';
import { Vocabulary } from '../src/vocab/vocabulary.ts';

const vocabulary = new Vocabulary(['vanilla-breeze@0.3.1'], null, 'x-');
const HOUSE: SerializeOptions = { voidElements: 'xhtml', booleanValue: 'true', vocabulary, isBoolean: vocabularyBooleans(vocabulary) };
const FIXTURES = join(import.meta.dirname, 'fixtures');

const write = (html: string, context: string | null = 'body', options: Partial<SerializeOptions> = {}) =>
  serialize(parseHtml(html, context).root, { ...HOUSE, ...options });

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (entry.endsWith('.html')) yield path;
  }
}

test('every fixture round-trips, and serializing the reparse gives the same bytes', () => {
  const failures: string[] = [];
  for (const file of htmlFiles(FIXTURES)) {
    const decoded = decodeUtf8(new Uint8Array(readFileSync(file)));
    if (!decoded.ok) continue;
    const context = basename(file).split('.').find((f) => f.startsWith('ctx-'))?.slice(4) ?? null;
    const tree = parseHtml(decoded.text, context).root;
    const out = serialize(tree, HOUSE);
    const reparsed = parseHtml(out, context).root;
    const difference = compareTrees(tree, reparsed, HOUSE);
    if (difference) failures.push(`${relative(FIXTURES, file)}: ${JSON.stringify(difference)}`);
    else if (serialize(reparsed, HOUSE) !== out) failures.push(`${relative(FIXTURES, file)}: not stable`);
  }
  assert.deepEqual(failures, []);
});

test('serialized known-good pages have no style findings under strict', async () => {
  for (const name of ['house-page.html', 'rich-page.standard.html']) {
    const text = readFileSync(join(FIXTURES, 'known-good', name), 'utf8');
    const out = serialize(parseHtml(text, null).root, HOUSE);
    const [file] = (await check({ path: name, source: out }, { profile: 'strict' })).files;
    assert.deepEqual(file!.findings.filter((f) => f.rule.startsWith('style/')).map((f) => `${f.rule} ${f.line}:${f.column}`), [], name);
  }
});

test('block layout: one child per line; html’s children stay at its level', () => {
  assert.equal(
    write('<!doctype html><html lang="en"><head><title>T</title></head><body><main><ul><li>a</li><li>b</li></ul></main></body></html>', null),
    '<!doctype html>\n<html lang="en">\n<head>\n  <title>T</title>\n</head>\n<body>\n  <main>\n    <ul>\n      <li>a</li>\n      <li>b</li>\n    </ul>\n  </main>\n</body>\n</html>\n',
  );
});

test('inline content is written as built; line breaks in whitespace-only text are re-indented', () => {
  assert.equal(write('<p>One <a href="/x">two</a> three</p>'), '<p>One <a href="/x">two</a> three</p>\n');
  assert.equal(write('<p><a href="/a">A</a><a href="/b">B</a></p>'), '<p><a href="/a">A</a><a href="/b">B</a></p>\n');
  assert.equal(write('<section>\n<form-field>\n      <label for="x">X</label>\n<input id="x" name="x" />\n</form-field></section>'),
    '<section>\n  <form-field>\n    <label for="x">X</label>\n    <input id="x" name="x" />\n  </form-field>\n</section>\n');
});

test('whitespace that can’t render is dropped, so formatting doesn’t change the output', () => {
  assert.equal(write('<ul>\n\n   <li>a</li>   <li>b</li>\n</ul>'), write('<ul><li>a</li><li>b</li></ul>'));
  assert.equal(write('<svg viewBox="0 0 1 1">\n  <rect width="1" height="1"/>\n</svg>'), '<svg viewBox="0 0 1 1">\n  <rect width="1" height="1" />\n</svg>\n');
});

test('booleans and void elements take the configured forms', () => {
  const html = '<input name="a" required="" disabled><br><accordion-wc single></accordion-wc>';
  assert.equal(write(html), '<input name="a" required="true" disabled="true" /><br />\n<accordion-wc single="true"></accordion-wc>\n');
  assert.equal(write(html, 'body', { booleanValue: 'empty', voidElements: 'html' }), '<input name="a" required="" disabled=""><br>\n<accordion-wc single=""></accordion-wc>\n');
  assert.equal(write(html, 'body', { booleanValue: 'name', voidElements: 'tight' }), '<input name="a" required="required" disabled="disabled"/><br/>\n<accordion-wc single="single"></accordion-wc>\n');
});

test('escaping: text, attributes, raw text, and no-break spaces', () => {
  assert.equal(write('<p title="a &amp; &quot;b&quot; &lt;c&gt;">1 &lt; 2 &amp;&amp; 3 &gt; 2&nbsp;!</p>'), '<p title="a &amp; &quot;b&quot; &lt;c&gt;">1 &lt; 2 &amp;&amp; 3 &gt; 2&nbsp;!</p>\n');
  assert.equal(write('<script>if (a < b && c) {}</script>'), '<script>if (a < b && c) {}</script>\n');
  assert.equal(write('<textarea name="t">a &lt;/textarea&gt; b</textarea>'), '<textarea name="t">a &lt;/textarea&gt; b</textarea>\n');
});

test('pre and textarea keep their content exactly, doubling a leading newline the parser drops', () => {
  assert.equal(write('<pre>\n\nfirst\n  second</pre>'), '<pre>\n\nfirst\n  second</pre>\n');
  assert.equal(write('<pre><code>x\n  y</code></pre>'), '<pre><code>x\n  y</code></pre>\n');
});

test('foreign elements keep their case and close themselves; template contents are written', () => {
  assert.equal(write('<svg viewbox="0 0 1 1"><foreignobject></foreignobject><path d="M0 0"></path></svg>'),
    '<svg viewBox="0 0 1 1">\n  <foreignObject />\n  <path d="M0 0" />\n</svg>\n');
  assert.equal(write('<template id="row"><tr><td>x</td></tr></template>'), '<template id="row">\n  <tr>\n    <td>x</td>\n  </tr>\n</template>\n');
});

test('the comparison reports where trees differ', () => {
  const a = parseHtml('<ul><li>a</li><li title="x">b</li></ul>', 'body').root;
  const b = parseHtml('<ul><li>a</li><li title="y">b</li></ul>', 'body').root;
  assert.deepEqual(compareTrees(a, b, HOUSE), { path: '/ul[1]/li[2]', expected: 'attributes title="x"', found: 'attributes title="y"' });
  const c = parseHtml('<p>a <b>b</b></p>', 'body').root;
  const d = parseHtml('<p>a<b>b</b></p>', 'body').root;
  assert.equal(compareTrees(c, d, HOUSE)?.path, '/p[1]/#text[1]');
});
