import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unifiedDiff } from '../src/fix/diff.ts';
import { fix } from '../src/fix/fix.ts';
import { treeSignature } from './helpers.ts';

test('fix applies fixes in rounds until nothing is left, keeping the tree', async () => {
  const source = '<!doctype html>\n<meta charset="utf-8" />\n<title>T</title>\n<P CLASS=note>One<br>Two\n';
  const r = await fix({ path: 'a.html', source }, { profile: 'strict' });
  assert.equal(r.after, '<!doctype html>\n<html><head><meta charset="utf-8" />\n<title>T</title>\n</head><body><p class="note">One<br />Two\n</p></body></html>\n');
  assert.equal(treeSignature(r.after, null), treeSignature(source, null));
  assert.ok(!r.report.files[0]!.findings.some((f) => f.fix));
  const again = await fix({ path: 'a.html', source: r.after }, { profile: 'strict' });
  assert.equal(again.after, again.before, 'a second run changes nothing');
});

test('fix keeps a fix that would change the tree as a suggestion', async () => {
  // The </p> would go at the end of the file, inside the comment that never closes.
  const r = await fix({ path: 'a.html', source: '<p>Text<!-- never closed', context: 'main' }, { profile: 'strict' });
  assert.deepEqual(r.dropped.map((d) => d.rule), ['style/explicit-end-tag']);
  assert.equal(r.after, r.before);
});

test('fix keeps the BOM and line endings', async () => {
  const r = await fix({ path: 'a.html', source: '﻿<ul>\r\n<li>One\r\n</ul>\r\n', context: 'main' }, { profile: 'strict' });
  assert.equal(r.bom, true);
  assert.equal(r.after, '<ul>\r\n<li>One\r\n</li></ul>\r\n');
});

/** Applies a unified diff to text, as `patch` would. */
function patch(text: string, diff: string): string {
  const lines = text === '' ? [] : text.split('\n');
  const hadNewline = text.endsWith('\n');
  if (hadNewline) lines.pop();
  const out: string[] = [];
  let at = 0;
  let newline = hadNewline;
  const rows = diff.split('\n').slice(2);
  for (let i = 0; i < rows.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(rows[i]!);
    if (!m) continue;
    const start = Number(m[1]) - (m[2] === '0' ? 0 : 1);
    out.push(...lines.slice(at, start));
    at = start;
    for (i++; i < rows.length && !rows[i]!.startsWith('@@') && rows[i] !== ''; i++) {
      const row = rows[i]!;
      const noNewline = rows[i + 1] === '\\ No newline at end of file';
      if (row[0] === ' ' || row[0] === '-') at++;
      if (row[0] === ' ' || row[0] === '+') {
        out.push(row.slice(1));
        if (noNewline) newline = false;
        else if (at >= lines.length) newline = true;
      }
      if (noNewline) i++;
    }
    i--;
  }
  out.push(...lines.slice(at));
  return out.join('\n') + (newline && out.length ? '\n' : '');
}

test('unifiedDiff output applies back to the original', () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rand(20) }, () => `line ${rand(6)}`);
    const b = a.flatMap((l) => (rand(5) === 0 ? [] : rand(6) === 0 ? [l, `new ${rand(9)}`] : [l]));
    const before = a.join('\n') + (rand(2) ? '\n' : '');
    const after = b.join('\n') + (rand(2) ? '\n' : '');
    if (before === after) continue;
    assert.equal(patch(before, unifiedDiff('f', before, after)), after, JSON.stringify([before, after]));
  }
});
