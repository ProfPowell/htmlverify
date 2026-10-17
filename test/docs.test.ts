import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, explain, RULES } from '../src/index.ts';
import { RULE_DOCS } from '../src/rules/docs.ts';

// Each rule's documented examples behave as documented, in the strict profile.
for (const rule of RULES) {
  test(`explain ${rule.id}`, async () => {
    const doc = RULE_DOCS[rule.id];
    assert.ok(doc, `${rule.id} has no doc in src/rules/docs.ts`);
    const context = doc.context === undefined ? 'div' : doc.context;
    const rulesIn = async (source: string) =>
      (await check({ path: 'example.html', source, context }, { profile: 'strict' })).files[0]!.findings.map((f) => f.rule);
    assert.ok((await rulesIn(doc.fails)).includes(rule.id), `the failing example doesn’t report ${rule.id}`);
    assert.ok(!(await rulesIn(doc.passes)).includes(rule.id), `the passing example reports ${rule.id}`);
    assert.equal(explain(rule.id).id, rule.id);
  });
}

test('every doc belongs to a registered rule', () => {
  const ids = new Set(RULES.map((r) => r.id));
  for (const id of Object.keys(RULE_DOCS)) assert.ok(ids.has(id), id);
});

test('explain rejects unknown rules with a suggestion', () => {
  assert.throws(() => explain('content/chld'), /did you mean "content\/child"/);
});
