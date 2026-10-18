import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, type AssemblyResult } from '../src/assemble/assemble.ts';
import { isPage } from '../src/assemble/contract.ts';
import { openRegistry } from '../src/assemble/lifecycle.ts';
import { canonicalJson } from '../src/report/canonical.ts';
import { DEFAULT_VOCABULARIES, Vocabulary } from '../src/vocab/vocabulary.ts';
import { PlanGenerator, random } from './generate.ts';

/*
 * Assembler properties (spec §12.3): plans generated with random in-contract
 * data always pass strict, round-trip, and assemble byte-identically twice.
 * Each run is seeded; a failure prints its seed and plan, and
 * HTMLVERIFY_SEED=<n> reruns that seed alone. HTMLVERIFY_PLANS raises the
 * number of plans per registry.
 */

const ROOT = join(import.meta.dirname, '..');
const PLANS = Number(process.env['HTMLVERIFY_PLANS'] ?? 40);
const ONLY = process.env['HTMLVERIFY_SEED'];
const vocabulary = new Vocabulary(DEFAULT_VOCABULARIES, null, 'x-');

/** What must hold for one plan; returns the reasons it doesn't. */
async function violations(plan: object, registry: ReturnType<typeof openRegistry>): Promise<string[]> {
  const source = JSON.stringify(plan, null, 2);
  const first = await assemble(source, { registry, draft: true });
  const out: string[] = [];
  const errors = (r: AssemblyResult) => [
    ...r.plan.findings.filter((f) => f.severity === 'error').map((f) => `plan ${f.rule}: ${f.message}`),
    ...(r.report?.files[0]?.findings ?? []).filter((f) => f.severity === 'error').map((f) => `output ${f.line}:${f.column} ${f.rule}: ${f.message}`),
  ];
  if (first.status !== 'pass') out.push(...errors(first), ...(errors(first).length ? [] : ['fails without an error']));
  if (first.plan.findings.some((f) => f.rule === 'assembly/round-trip')) out.push('doesn’t round-trip');
  const second = await assemble(source, { registry, draft: true });
  if (second.html !== first.html) out.push('assembles to different HTML the second time');
  if (canonicalJson(second.report) !== canonicalJson(first.report)) out.push('reports differently the second time');
  return out;
}

function properties(name: string, root: string) {
  test(`${name}: random page and fragment plans pass strict, round-trip, and assemble the same twice`, async () => {
    const registry = openRegistry(root);
    assert.deepEqual(registry.problems, []);
    const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: PLANS }, (_, i) => i + 1);
    let pages = 0;
    let fragments = 0;
    for (const seed of seeds) {
      const generator = new PlanGenerator(registry, vocabulary, random(seed));
      const plans: object[] = [];
      const page = generator.page();
      if (page) plans.push(page);
      for (const component of registry.components.values()) {
        if (isPage(component.contract)) continue;
        const fragment = generator.fragment(component);
        if (fragment) plans.push(fragment);
      }
      for (const plan of plans) {
        const problems = await violations(plan, registry);
        assert.deepEqual(problems, [], `seed ${seed}: rerun with HTMLVERIFY_SEED=${seed}\n${JSON.stringify(plan, null, 2)}`);
        if ('page' in plan) pages++;
        else fragments++;
      }
    }
    // Draws that can't complete, such as a ref with no target, are skipped; most must complete.
    assert.ok(pages >= seeds.length * 0.8, `only ${pages} of ${seeds.length} page plans could be drawn`);
    assert.ok(fragments > 0);
  });
}

properties('test registry', join(ROOT, 'test/registry'));
properties('starter registry', join(ROOT, 'registry'));
