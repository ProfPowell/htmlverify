import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/index.ts';
import { runNu, type NuMessage } from '../src/nu/nu.ts';
import { LineIndex } from '../src/parse/lines.ts';
import { PROFILES } from '../src/profiles.ts';
import { crossCheck, type Finding } from '../src/report/report.ts';

const finding = (rule: string, line: number, column: number, endColumn: number): Finding => ({
  rule, severity: 'error', authority: 'standard', message: rule, path: 'p.html',
  line, column, endLine: line, endColumn, offset: 0, endOffset: 0, fix: null, origin: null,
});
const nu = (line: number, column: number, message: string, severity: NuMessage['severity'] = 'error'): NuMessage => ({ severity, line, column, endLine: line, message });

test('Nu messages attach to the local finding nearest them on the line; the rest become conformance/nu', () => {
  const findings = [finding('syntax/stray-end-tag', 3, 11, 18), finding('content/context', 3, 23, 27), finding('syntax/doctype', 1, 1, 1)];
  const lines = new LineIndex('a\nb\nc\nd\n');
  const extra = crossCheck(findings, [], [
    nu(3, 23, 'Element “li” not allowed as child of element “div”.'),
    nu(3, 11, 'Stray end tag “span”.'),
    nu(2, 1, 'Start tag seen without seeing a doctype first. Expected “<!DOCTYPE html>”.'),
    nu(4, 1, 'Bad value for attribute.'),
    nu(4, 2, 'Trailing slash on void elements has no effect.', 'info'),
    nu(4, 3, 'CSS: “container-type”: Property “container-type” doesn’t exist.'),
    nu(4, 4, 'The “name” attribute is never allowed on the “icon-wc” element.', 'info'),
  ], '26.10.12 (973e40b)', 'p.html', lines, PROFILES.strict);
  assert.deepEqual(findings.map((f) => (f.related ?? []).map((r) => r.message.slice(0, 12))), [['Stray end ta'], ['Element “li”'], ['Start tag se']]);
  assert.deepEqual(extra.map((f) => [f.rule, f.severity, f.line, f.message]), [['conformance/nu', 'error', 4, 'Bad value for attribute.']]);
  assert.equal(findings[0]!.related![0]!.source, 'nu@26.10.12');
});

test('without Java or the jar, the cross-check is untested and the status comes from local rules', async () => {
  assert.match((await runNu([new Uint8Array([60])], { jar: join(import.meta.dirname, 'no-such.jar') })).unavailable ?? '', /vnu\.jar isn’t at/);
  assert.equal((await runNu([new Uint8Array([60])], { jar: join(import.meta.dirname, '..', 'package.json'), java: 'htmlverify-no-such-java' })).unavailable, 'Java isn’t installed');
  const [file] = (await check({ path: 'p.html', source: '<!doctype html><p>x</p>' }, { nu: { jar: 'no-such.jar' } })).files;
  assert.ok(file!.coverage.untested.some((u) => u.check === 'conformance/nu'));
  const [fragment] = (await check({ path: 'f.html', source: '<p>x</p>', context: 'main' }, { nu: { jar: 'no-such.jar' } })).files;
  assert.ok(fragment!.coverage.untested.some((u) => u.check === 'conformance/nu'));
});

// Runs only where a vnu.jar is available: HTMLVERIFY_VNU_JAR, or the vnu-jar package.
const jar = process.env['HTMLVERIFY_VNU_JAR'] ?? join(import.meta.dirname, '..', 'node_modules', 'vnu-jar', 'build', 'dist', 'vnu.jar');
test('a real Nu run cross-checks a document', { skip: !existsSync(jar) && 'no vnu.jar' }, async () => {
  const report = await check({ path: 'p.html', source: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><title>x</title></head>\n<body><p>a</span></p></body></html>\n' }, { nu: { jar } });
  assert.match(report.tool.nu ?? '', /^\d+\.\d+\.\d+/);
  const stray = report.files[0]!.findings.find((f) => f.rule === 'syntax/stray-end-tag');
  assert.match(stray?.related?.[0]?.message ?? '', /Stray end tag/);
});
