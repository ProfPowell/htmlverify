import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, RULES } from '../src/index.ts';
import { BASE, MUTATIONS, mutants } from './corpus.ts';

// Each mutant (test/corpus.ts) must trigger its rule: recall must be 100%.

// Rules that a single defect can't express: review-only judgments, the opt-in denylist, Nu, and page-wide ratios.
const EXEMPT = new Set(['semantic/heading-candidate', 'semantic/list-candidate', 'policy/elements', 'conformance/nu', 'bloat/generic-ratio']);

test('the base page has no errors under strict', async () => {
  const [file] = (await check({ path: 'house.html', source: BASE }, { profile: 'strict' })).files;
  assert.deepEqual(file!.findings.filter((f) => f.severity === 'error').map((f) => f.rule), []);
});

test('every deterministic rule has a mutation', () => {
  const covered = new Set(MUTATIONS.map(([rule]) => rule));
  assert.deepEqual(RULES.map((r) => r.id).filter((id) => !covered.has(id) && !EXEMPT.has(id)), []);
});

test('each mutant triggers its rule: 100% recall', async () => {
  const missed: string[] = [];
  for (const { rule, edits, html } of mutants()) {
    const [file] = (await check({ path: 'mutant.html', source: html }, { profile: 'strict' })).files;
    const reported = new Set([...file!.findings.flatMap((f) => [f.rule, ...(f.alsoReportedBy ?? [])]), ...file!.reviews.map((r) => r.rule)]);
    if (!reported.has(rule)) missed.push(`${rule} (${edits.map(([, r]) => r.slice(0, 40)).join(' / ')})`);
  }
  assert.deepEqual(missed, []);
});
