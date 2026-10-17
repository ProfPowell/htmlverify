import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { check, type ProfileName } from '../src/index.ts';
import { decodeUtf8 } from '../src/parse/decode.ts';
import { applyEdits, treeSignature } from './helpers.ts';

/*
 * Golden fixtures: test/fixtures/<family>/<rule>/<case>[.<flag>…].html with the
 * expected findings in <case>[.<flag>…].json. Flags: `standard` selects the
 * standard profile; `ctx-<tag>` checks the file as a fragment inside <tag>.
 * A `fail-` case must report its rule and a `pass` case must not; `boundary-`
 * cases rely on the golden file alone. Review items follow the findings.
 * Run with UPDATE_GOLDEN=1 to rewrite
 * the golden files, then review the diff.
 */

const ROOT = join(import.meta.dirname, 'fixtures');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (entry.endsWith('.html')) yield path;
  }
}

for (const file of htmlFiles(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const parts = rel.split('/');
  const rule = parts.length === 3 ? `${parts[0]}/${parts[1]}` : null;
  const [caseName = '', ...flags] = basename(file, '.html').split('.');
  const profile: ProfileName = flags.includes('standard') ? 'standard' : 'strict';
  const context = flags.find((f) => f.startsWith('ctx-'))?.slice(4) ?? null;

  test(rel, async () => {
    const bytes = new Uint8Array(readFileSync(file));
    const [result] = (await check({ path: rel, source: bytes, context }, { profile })).files;
    assert.ok(result);

    // A finding merged into another family's still counts for its rule.
    const reports = (f: (typeof result.findings)[number]) => f.rule === rule || (f.alsoReportedBy ?? []).includes(rule ?? '');
    if (rule && caseName.startsWith('fail-')) {
      assert.ok(result.findings.some(reports), `expected a ${rule} finding`);
    }
    if (rule && caseName.startsWith('pass')) {
      assert.ok(!result.findings.some(reports), `unexpected ${rule} finding`);
    }

    const actual = `${JSON.stringify([
      ...result.findings.map((f) => ({
        rule: f.rule,
        severity: f.severity,
        at: `${f.line}:${f.column}-${f.endLine}:${f.endColumn}`,
        message: f.message,
        ...(f.alsoReportedBy ? { alsoReportedBy: f.alsoReportedBy } : {}),
        ...(f.fix ? { fix: f.fix.edits } : {}),
      })),
      ...result.reviews.map((r) => ({ rule: r.rule, review: `${r.line}:${r.column}`, ask: r.ask })),
    ], null, 2)}\n`;
    const golden = file.replace(/\.html$/, '.json');
    if (UPDATE) writeFileSync(golden, actual);
    else {
      assert.ok(existsSync(golden), `missing ${relative(ROOT, golden)}; run UPDATE_GOLDEN=1 npm test`);
      assert.equal(actual, readFileSync(golden, 'utf8'));
    }

    // Every proposed fix keeps the tree identical and resolves its finding.
    const edits = result.findings.flatMap((f) => f.fix?.edits ?? []);
    if (edits.length === 0) return;
    const decoded = decodeUtf8(bytes);
    assert.ok(decoded.ok);
    const fixed = applyEdits(decoded.text, edits);
    assert.equal(treeSignature(fixed, context), treeSignature(decoded.text, context), 'fixes must preserve the tree');
    const recheck = (await check({ path: rel, source: (decoded.bom ? '﻿' : '') + fixed, context }, { profile })).files[0]!;
    assert.deepEqual(recheck.findings.filter((f) => f.fix).map((f) => `${f.rule} ${f.line}:${f.column}`), [], 'fixes must resolve every fixable finding');
  });
}
