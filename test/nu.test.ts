import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/index.ts';
import { runNu, type NuMessage } from '../src/nu/nu.ts';
import { LineIndex } from '../src/parse/lines.ts';
import { PROFILES } from '../src/profiles.ts';
import { crossCheck, type Finding, type Review } from '../src/report/report.ts';
import { mutants } from './corpus.ts';

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

test('a Nu message at another place a finding names matches it; a review item never absorbs an error', () => {
  const unclosed = { ...finding('syntax/unclosed-element', 2, 1, 10), alsoAt: [{ line: 9, column: 1 }] };
  const review: Review = { rule: 'a11y/img-alt', line: 5, column: 1, offset: 0, endOffset: 0, ask: 'Does alt="A" describe the image?' };
  const extra = crossCheck([unclosed], [review], [
    nu(9, 1, 'End tag “details” seen, but there were open elements.'),
    nu(5, 1, 'When the “srcset” attribute has any image candidate string with a width descriptor, the “sizes” attribute must also be specified.'),
    nu(5, 3, 'Consider adding a “lang” attribute.', 'warning'),
  ], null, 'p.html', new LineIndex('a\n'.repeat(10)), PROFILES.standard);
  assert.deepEqual(unclosed.related?.map((r) => r.line), [9]);
  assert.deepEqual(review.related?.map((r) => r.message.slice(0, 8)), ['Consider']);
  assert.deepEqual(extra.map((f) => f.line), [5]);
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

/*
 * The Nu differential (spec §12.3): every Nu error or warning on the corpus
 * (document fixtures, known-good pages, and mutants) matches a local finding
 * or test/nu-gaps.json, and every listed message still occurs, unmatched, on
 * its example. One Nu run covers both, under standard.
 */
interface Gap { message: string; severity: 'error' | 'warning'; kind: 'gap' | 'disagreement'; reason: string; example: string }
const GAPS = (JSON.parse(readFileSync(join(import.meta.dirname, 'nu-gaps.json'), 'utf8')) as { gaps: Gap[] }).gaps;
const FIXTURES = join(import.meta.dirname, 'fixtures');
const page = (body: string) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Example</title>\n</head>\n<body>\n<main>\n<h1>Example</h1>\n${body}\n</main>\n</body>\n</html>\n`;

function* documents(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* documents(path);
    else if (entry.endsWith('.html') && !entry.includes('.ctx-')) yield path;
  }
}

let differential: ReturnType<typeof check> | null = null;
const run = () => (differential ??= check([
  ...[...documents(FIXTURES)].map((path) => ({ path: relative(FIXTURES, path), source: new Uint8Array(readFileSync(path)) })),
  ...mutants().map((m, i) => ({ path: `mutant ${i} (${m.rule})`, source: m.html })),
  ...GAPS.map((g, i) => ({ path: `gap ${i}`, source: page(g.example) })),
], { profile: 'standard', nu: { jar } }));
const surfaced = (findings: Finding[]) => findings.filter((f) => f.rule === 'conformance/nu' && f.severity !== 'info');
const listed = (f: Finding) => GAPS.some((g) => g.severity === f.severity && new RegExp(g.message).test(f.message));

test('every listed Nu gap has a valid pattern, a kind, a reason, and an example', () => {
  for (const g of GAPS) {
    assert.doesNotThrow(() => new RegExp(g.message), g.message);
    assert.ok(['error', 'warning'].includes(g.severity) && ['gap', 'disagreement'].includes(g.kind), g.message);
    assert.ok(g.reason.length > 0 && g.example.length > 0, g.message);
  }
});

test('Nu differential: every Nu message on the corpus matches a local finding or a listed gap', { skip: !existsSync(jar) && 'no vnu.jar' }, async () => {
  const report = await run();
  const unexplained = report.files.filter((file) => !file.path.startsWith('gap ')).flatMap((file) =>
    surfaced(file.findings).filter((f) => !listed(f)).map((f) => `${file.path}:${f.line}:${f.column} ${f.severity}: ${f.message}`));
  assert.deepEqual(unexplained, [], `Nu ${report.tool.nu}: add a rule that reports these, or list them in test/nu-gaps.json`);
});

test('each listed Nu gap still occurs on its example, unmatched', { skip: !existsSync(jar) && 'no vnu.jar' }, async () => {
  const report = await run();
  const stale = GAPS.flatMap((g, i) => {
    const pattern = new RegExp(g.message);
    const file = report.files.find((f) => f.path === `gap ${i}`)!;
    if (surfaced(file.findings).some((f) => f.severity === g.severity && pattern.test(f.message))) return [];
    const by = [...file.findings, ...file.reviews].find((f) => f.related?.some((r) => pattern.test(r.message)));
    return [`${g.message} — ${by ? `now matched by ${by.rule}; remove it from the list` : `Nu ${report.tool.nu} no longer reports it`}`];
  });
  assert.deepEqual(stale, []);
});
