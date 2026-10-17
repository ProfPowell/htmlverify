import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexIds, resolveId } from '../src/analysis/ids.ts';
import { parseHtml } from '../src/parse/parse.ts';
import { isElement, walk, type Element } from '../src/parse/tree.ts';
import { attributeRow } from '../src/spec/data.ts';
import { compile, Matcher, parseGrammar } from '../src/spec/grammar.ts';
import { isCustomElementName } from '../src/spec/model.ts';
import { isTimeValue, languageTagProblem, usesWidthDescriptors, valueProblem } from '../src/spec/values.ts';

function first(html: string): Element {
  const node = (parseHtml(html, 'div').root.childNodes as Element[]).find(isElement);
  assert.ok(node);
  return node;
}

/** The problem with the first element’s attribute, or null when it’s valid. */
function problem(html: string, attribute: string): string | null {
  const element = first(html);
  const value = element.attrs.find((a) => a.name === attribute)!.value;
  const row = attributeRow(element.tagName, attribute);
  assert.ok(row, `${element.tagName}[${attribute}] has a row`);
  return valueProblem(element, attribute, value, row)?.text ?? null;
}

test('dates and times follow the HTML microsyntaxes', () => {
  for (const ok of ['2026-10-17', '2024-02-29', '2026-10', '--10-17', '10-17', '14:30', '14:30:59.123', '2026-10-17T14:30', '2026-10-17 14:30',
    '2026-10-17T14:30Z', '2026-10-17T14:30+05:30', 'Z', '+0100', '2026-W53', '2020-W53', '42', 'PT2H30M', 'P1D', '1h 30m', '4.5s']) {
    assert.ok(isTimeValue(ok), ok);
  }
  for (const bad of ['2026-02-29', '2026-13-01', '2026-10-32', '24:00', '14:60', '2025-W53', 'P', 'PT', '1.5h', '1h 2h', 'tomorrow', '2026/10/17', '']) {
    assert.ok(!isTimeValue(bad), bad);
  }
});

test('language tags are well-formed BCP 47', () => {
  for (const ok of ['en', 'en-US', 'pt-BR', 'zh-Hant-TW', 'de-CH-1996', 'sr-Latn-RS', 'es-419', 'x-private', 'i-klingon', 'en-GB-oed', 'zh-yue']) {
    assert.equal(languageTagProblem(ok), null, ok);
  }
  for (const bad of ['en_US', 'english', 'e', 'en-', '-en', 'en--US', '1en']) assert.notEqual(languageTagProblem(bad), null, bad);
});

test('URL values', () => {
  assert.equal(problem('<a href="https://example.org/a?b=c&amp;d=e#f">x</a>', 'href'), null);
  assert.equal(problem('<a href="">x</a>', 'href'), null, 'href may be empty');
  assert.match(problem('<img src="" alt="">', 'src')!, /is empty/);
  assert.match(problem('<a href="/my page">x</a>', 'href')!, /space/);
  assert.match(problem('<a href="/{{slug}}">x</a>', 'href')!, /percent-encoded/);
  assert.match(problem('<a href="/50%off">x</a>', 'href')!, /%25/);
  assert.match(problem('<a href="http://">x</a>', 'href')!, /isn’t a valid URL/);
});

test('srcset follows the srcset parser, commas in URLs included', () => {
  assert.equal(problem('<img src="a.png" srcset="a.jpg, b.jpg 2x" alt="">', 'srcset'), null);
  assert.equal(problem('<img src="a.png" srcset="data:image/png;base64,AAAA 1x, b.png 2x" alt="">', 'srcset'), null);
  assert.match(problem('<img src="a.png" srcset="a.jpg 1x, b.jpg 1x" alt="">', 'srcset')!, /two candidates for 1x/);
  assert.match(problem('<img src="a.png" srcset="a.jpg 480w, b.jpg" alt="">', 'srcset')!, /mixes width descriptors/);
  assert.match(problem('<img src="a.png" srcset="a.jpg 2x 480w" alt="">', 'srcset')!, /more than one descriptor/);
  assert.match(problem('<img src="a.png" srcset="a.jpg 1x,, b.jpg 2x" alt="">', 'srcset')!, /stray comma/);
  assert.ok(usesWidthDescriptors('a.jpg 480w, b.jpg 960w'));
  assert.ok(!usesWidthDescriptors('a.jpg 1x, b.jpg 2x'));
});

test('sizes, autocomplete, and keyword values', () => {
  assert.equal(problem('<img src="a" sizes="(max-width: 600px) calc(100vw - 2rem), 50vw" alt="">', 'sizes'), null);
  assert.match(problem('<img src="a" sizes="100%" alt="">', 'sizes')!, /percentages/);
  assert.match(problem('<img src="a" sizes="100vw, (min-width: 9em) 50vw" alt="">', 'sizes')!, /without a media condition/);
  assert.equal(problem('<input autocomplete="section-a shipping street-address webauthn">', 'autocomplete'), null);
  assert.equal(problem('<input autocomplete="work tel">', 'autocomplete'), null);
  assert.match(problem('<input autocomplete="zip">', 'autocomplete')!, /Did you mean "postal-code"\?/);
  assert.match(problem('<input autocomplete="tel email">', 'autocomplete')!, /out of place/);
  assert.equal(problem('<button type="SUBMIT">x</button>', 'type'), null, 'keywords are case-insensitive');
  assert.match(problem('<ol type="X"><li>x</li></ol>', 'type')!, /use "1", "a", "A", "i", or "I"/);
  assert.match(problem('<input type="phone">', 'type')!, /Did you mean "tel"\?/);
});

test('custom element names', () => {
  for (const ok of ['my-element', 'x-y', 'math-α', 'a-b.c_d']) assert.ok(isCustomElementName(ok), ok);
  for (const bad of ['element', 'font-face', 'annotation-xml', '-x', '1-x']) assert.ok(!isCustomElementName(bad), bad);
});

test('the matcher reports what it expected', () => {
  const m = new Matcher(compile(parseGrammar('summary @flow*'), []));
  const isElement = (name: string) => (t: { kind: string; name?: string }) => t.kind === 'element' && t.name === name;
  assert.ok(!m.accepting());
  assert.ok(!m.step(isElement('p')));
  assert.deepEqual(m.expected(), [{ kind: 'element', name: 'summary' }]);
  assert.ok(m.step(isElement('summary')));
  assert.ok(m.accepting());
});

test('IDs are scoped to the document and to each template’s contents', () => {
  const parsed = parseHtml('<p id="a">1</p><template><p id="a">2</p><label for="a">L</label></template><label for="a">L</label>', 'div');
  const index = indexIds(parsed.root, 'fragment');
  assert.equal(index.scopes.length, 2);
  const labels = [...walk(parsed.root)].map((e) => e.node).filter((n): n is Element => isElement(n) && n.tagName === 'label');
  const [inside, outside] = labels;
  const text = (e: Element | null) => (e?.childNodes[0] as { value?: string } | undefined)?.value;
  assert.equal(text(resolveId(index, inside!, 'a')), '2');
  assert.equal(text(resolveId(index, outside!, 'a')), '1');
});
