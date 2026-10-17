import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { attributeRow, HTML, isEventHandler } from '../src/spec/data.ts';
import { compile, parseGrammar } from '../src/spec/grammar.ts';
import { OVERLAY_ELEMENTS } from '../src/spec/model.ts';
import { unmappedValueTypes } from '../src/spec/values.ts';

/*
 * data/overlay-basis.json pins the spec text (categories, contexts, content
 * model) that src/spec/model.ts was written against. When the spec data is
 * regenerated and an element's text changes, this test names the element:
 * review its model, then run UPDATE_GOLDEN=1 npm test.
 */

const BASIS = join(import.meta.dirname, '..', 'data', 'overlay-basis.json');

function basis(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, d] of Object.entries(HTML.definitions).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[name] = createHash('sha256').update(JSON.stringify([d.categories, d.contexts, d.contentModel])).digest('hex').slice(0, 16);
  }
  return out;
}

test('element models match the spec text they were written against', () => {
  const actual = basis();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(BASIS, `${JSON.stringify(actual, null, 2)}\n`);
  assert.ok(existsSync(BASIS), 'missing data/overlay-basis.json; run UPDATE_GOLDEN=1 npm test');
  const pinned = JSON.parse(readFileSync(BASIS, 'utf8')) as Record<string, string>;
  const changed = Object.keys({ ...pinned, ...actual }).filter((name) => pinned[name] !== actual[name]);
  assert.deepEqual(changed, [], `spec text changed for ${changed.map((n) => `<${n}>`).join(', ')}; review src/spec/model.ts`);
});

test('the overlay only names elements the spec defines', () => {
  for (const name of OVERLAY_ELEMENTS) assert.ok(name in HTML.definitions, name);
});

test('every attribute value type has a check', () => {
  assert.deepEqual(unmappedValueTypes(), []);
});

test('every attribute in the element index has an attribute row', () => {
  const missing: string[] = [];
  for (const [element, row] of Object.entries(HTML.elements)) {
    for (const attribute of row.attributes) {
      if (!attributeRow(element, attribute) && !isEventHandler(element, attribute)) missing.push(`${element}[${attribute}]`);
    }
  }
  assert.deepEqual(missing, []);
});

test('grammar syntax', () => {
  for (const bad of ['(li', 'li )', 'li!', '*', '#li', '%li']) assert.throws(() => parseGrammar(bad), /bad grammar/, bad);
  const nfa = compile(parseGrammar('caption? colgroup* thead? (tbody* | tr+) tfoot?'), []);
  assert.deepEqual(nfa.tokens.map((t) => (t.kind === 'element' ? t.name : t.kind)), ['caption', 'colgroup', 'thead', 'tbody', 'tr', 'tfoot']);
});
