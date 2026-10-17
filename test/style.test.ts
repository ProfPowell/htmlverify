import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/index.ts';
import { applyEdits, treeSignature } from './helpers.ts';

async function findings(source: string, context: string | null = 'div') {
  const [file] = (await check({ path: 'case.html', source, context }, { profile: 'strict' })).files;
  return file!.findings;
}

test('style/escape flags exactly the ampersands HTML reads as literal without an error', async () => {
  const cases: [string, boolean][] = [
    ['<p>a & b</p>', true],
    ['<p>a &amp; b</p>', false],
    ['<p>AT&T</p>', true],
    ['<p>&foo bar</p>', true],
    ['<p>&;</p>', true],
    ['<p>&#x41; &#65;</p>', false],
    ['<p>&notit;</p>', false], // the legacy prefix &not decodes, with a parse error
    ['<p>&foo;</p>', false], // unknown reference: a parse error, not style
    ['<p>&#;</p>', false], // no digits: a parse error
    ['<a href="/?a=1&b=2">x</a>', true],
    ['<a href="/?a=1&amp;b=2">x</a>', false],
    ['<a href="/?a=1&copy=2">x</a>', true], // in attributes &copy= stays literal
    ['<a href="/?a=1&ampx">x</a>', true],
    ['<a title="&copy;">x</a>', false],
  ];
  for (const [source, flagged] of cases) {
    assert.equal((await findings(source)).some((f) => f.rule === 'style/escape'), flagged, source);
  }
});

test('style/escape skips raw text and a self-closed textarea’s swallowed markup', async () => {
  assert.deepEqual((await findings('<script type="module">a < b && c > d</script>')).filter((f) => f.rule === 'style/escape'), []);
  assert.deepEqual((await findings('<noscript><p>a & b</p></noscript>')).filter((f) => f.rule === 'style/escape'), []);
  const swallowed = await findings('<label>Note <textarea name="n"/></label><p>a > b</p>');
  assert.ok(swallowed.some((f) => f.rule === 'syntax/self-closing-non-void'));
  assert.ok(!swallowed.some((f) => f.rule === 'style/escape'));
});

test('style/whitespace fixes keep the tree, and leave content alone', async () => {
  const sources = [
    '<ul>\n\t<li>One</li>  \n\t\t<li>Two</li>\n</ul>\n\n',
    '<table>\n\t<tbody>\n\t\t<tr><td>1</td></tr>\n\t</tbody>\n</table>',
    '<p>Text\n\twith a tab</p>\n',
    '<img src="/a.png"  \n\talt="A"\n/>\n',
  ];
  for (const source of sources) {
    const all = await findings(source);
    const edits = all.filter((f) => f.rule === 'style/whitespace').flatMap((f) => f.fix?.edits ?? []);
    const fixed = applyEdits(source, edits);
    assert.equal(treeSignature(fixed, 'div'), treeSignature(source, 'div'), source);
    assert.ok(!(await findings(fixed)).some((f) => f.rule === 'style/whitespace' && f.fix), source);
  }
  const text = await findings('<p>Text\n\twith a tab</p>\n');
  assert.deepEqual(text.filter((f) => f.rule === 'style/whitespace').map((f) => [f.line, f.fix]), [[2, null]]);
});

test('style/whitespace expands tabs to tab stops of the configured width', async () => {
  const [fix] = (await findings('<ul>\n \t<li>One</li>\n</ul>\n')).filter((f) => f.rule === 'style/whitespace');
  assert.deepEqual(fix?.fix?.edits, [{ offset: 5, endOffset: 7, text: '  ' }]);
});

test('style/whitespace leaves the end of a phrasing fragment alone', async () => {
  assert.ok(!(await findings('<em>Inline</em>', 'span')).some((f) => f.rule === 'style/whitespace'));
  assert.ok((await findings('<p>Block</p>', 'div')).some((f) => f.rule === 'style/whitespace'));
});
