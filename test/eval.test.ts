import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { countMatches, parsePage, scoreChecklist, skeletonDistance, variance, type Brief } from '../eval/lib.ts';

const BRIEFS = join(import.meta.dirname, '..', 'eval', 'briefs');

test('checklist selectors: lists, descendant and child combinators, attribute operators', () => {
  const page = parsePage('<!doctype html><main><nav><a href="#a">A</a><a href="/b">B</a></nav><ol><li>1</li></ol><ul><li><p>2</p></li></ul></main>');
  assert.equal(countMatches(page, 'nav a[href]'), 2);
  assert.equal(countMatches(page, "nav a[href^='#']"), 1);
  assert.equal(countMatches(page, 'ol > li'), 1);
  assert.equal(countMatches(page, 'ol > li, ul > li'), 2);
  assert.equal(countMatches(page, 'main > li'), 0);
  assert.equal(countMatches(page, 'main li'), 2);
});

test('every brief has real content and a checklist that its selectors can score', () => {
  const files = readdirSync(BRIEFS).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 20);
  const empty = parsePage('<!doctype html><p>x</p>');
  for (const file of files) {
    const brief = JSON.parse(readFileSync(join(BRIEFS, file), 'utf8')) as Brief;
    assert.equal(`${brief.id}.json`, file);
    assert.ok(brief.content.length > 300, `${brief.id} has little content`);
    assert.ok(!/lorem ipsum/i.test(brief.content), `${brief.id} uses filler`);
    assert.ok(brief.checklist.length >= 3, `${brief.id} has a short checklist`);
    assert.doesNotThrow(() => scoreChecklist(empty, brief.checklist), brief.id);
  }
});

test('structural variance is the mean pairwise normalized edit distance of skeletons', () => {
  assert.equal(skeletonDistance(['html', 'body', 'p'], ['html', 'body', 'p']), 0);
  assert.equal(skeletonDistance(['a', 'b'], ['a', 'c']), 0.5);
  assert.equal(variance([['a'], ['a'], ['b']]), 2 / 3);
  assert.equal(variance([['a']]), null);
});
