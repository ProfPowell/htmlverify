import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalog, checkRegistry, openRegistry, STARTER_REGISTRY } from '../src/assemble/lifecycle.ts';
import { formatComponentCheck } from '../src/report/text.ts';

/*
 * The starter registry (spec §9.11) that ships in registry/: every component
 * compiles, renders each fixture cleanly under strict, matches its expected
 * output, and meets every coverage goal, so it's ready for approval. Which
 * components are approved is for registry check, the CI gate, to report.
 */

test('the starter registry ships with the package, where the CLI falls back to it', () => {
  assert.equal(STARTER_REGISTRY, join(import.meta.dirname, '..', 'registry'));
});

test('every starter component checks clean, with full coverage', async () => {
  const registry = openRegistry(STARTER_REGISTRY);
  assert.deepEqual(registry.problems, []);
  const result = await checkRegistry(registry);
  const failing = result.components.filter((c) => c.status !== 'pass');
  assert.deepEqual(failing.map((c) => c.id), [], failing.map((c) => formatComponentCheck(c)).join('\n'));
  assert.deepEqual(result.components.map((c) => c.id), [
    'action/button', 'action/link-button', 'action/submit',
    'content/address', 'content/callout', 'content/card-list', 'content/faq', 'content/figure', 'content/image', 'content/prose', 'content/quote', 'content/result-list', 'content/section',
    'data/description-list', 'data/table', 'dialog/modal', 'disclosure/details', 'disclosure/tabs',
    'form/checkbox', 'form/checkbox-group', 'form/choice-group', 'form/fieldset', 'form/file-field', 'form/form', 'form/number-field', 'form/search', 'form/select-field', 'form/text-field', 'form/textarea-field',
    'nav/breadcrumb', 'nav/pagination', 'nav/primary', 'nav/steps', 'nav/toc', 'page/article', 'page/basic', 'site/footer',
  ]);
});

test('the catalog describes each starter component on one line', () => {
  // Pinned without the review status, which approval changes; UPDATE_GOLDEN=1 rewrites it.
  const lines = `${catalog(STARTER_REGISTRY).map((c) => c.line.replace(/ \[(?:unreviewed|stale)\]$/, '')).join('\n')}\n`;
  const golden = join(import.meta.dirname, 'starter.catalog.txt');
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(golden, lines);
  assert.equal(lines, readFileSync(golden, 'utf8'));
});
