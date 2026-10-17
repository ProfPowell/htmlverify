import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { LIMITS } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'htmlverify.js');
const PASS = join(ROOT, 'test/fixtures/syntax/doctype/pass.html');
const FAIL = join(ROOT, 'test/fixtures/style/attr-quotes/fail-unquoted.html');
const dir = mkdtempSync(join(tmpdir(), 'htmlverify-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdin: (async function* () {
      if (stdin) yield stdin;
    })(),
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    cwd: ROOT,
  });
  return { code, stdout, stderr };
}

test('a clean file passes with exit 0', async () => {
  const r = await run(['check', PASS]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ pass · 0 errors/);
});

test('a failing file exits 1 and names the rule, position, and fix', async () => {
  const r = await run(['check', FAIL]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /test\/fixtures\/style\/attr-quotes\/fail-unquoted\.html\n {2}10:4 +error +style\/attr-quotes +Quote the value with double quotes: class="card"\. {2}\[fix\]/);
});

test('--format json emits one canonical report', async () => {
  const r = await run(['check', PASS, FAIL, '--format', 'json']);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.files.map((f: { status: string }) => f.status), ['pass', 'fail']);
  assert.equal(report.profile.name, 'strict');
  assert.match(report.profile.hash, /^sha256:[0-9a-f]{64}$/);
});

test('stdin is read with -, labeled by --stdin-name', async () => {
  const r = await run(['check', '-', '--stdin-name', 'snippet.html', '--context', 'tbody'], '<tr><td>1</td></tr>');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^snippet\.html\n/);
});

test('--profile standard skips house style', async () => {
  const r = await run(['check', FAIL, '--profile', 'standard']);
  assert.equal(r.code, 0);
});

test('globs expand in sorted order; a glob with no match is an input error', async () => {
  const ok = await run(['check', 'test/fixtures/syntax/doctype/*.html', '--format', 'json']);
  const paths = JSON.parse(ok.stdout).files.map((f: { path: string }) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(paths.length, 3);
  const none = await run(['check', 'test/fixtures/**/*.nothing']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no files match/);
});

test('usage and input errors exit 2', async () => {
  for (const args of [[], ['lint', PASS], ['check'], ['check', PASS, '--bogus'], ['check', PASS, '--profile', 'loose'], ['check', PASS, '--format', 'xml'], ['check', 'missing.html'], ['check', PASS, '--context', 'Bad Tag']]) {
    const r = await run(args);
    assert.equal(r.code, 2, `args ${args.join(' ')}`);
    assert.match(r.stderr, /^htmlverify: /);
  }
});

test('limits make the result incomplete, exit 3', async () => {
  const deep = await run(['check', '-'], `<!doctype html>${'<section>'.repeat(LIMITS.depth + 5)}`);
  assert.equal(deep.code, 3);
  assert.match(deep.stdout, /! incomplete/);
  const big = join(dir, 'big.html');
  writeFileSync(big, 'x'.repeat(LIMITS.bytes + 1));
  assert.equal((await run(['check', big])).code, 3);
});

test('--version and --help', async () => {
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match((await run(['check', '--help'])).stdout, /^Usage:\n {2}htmlverify check/);
});

test('the bin shim runs the CLI and sets the exit code', () => {
  const r = spawnSync(process.execPath, [BIN, 'check', FAIL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /style\/attr-quotes/);
});

test('canonical JSON is byte-identical across two processes', () => {
  const args = [BIN, 'check', 'test/fixtures/**/*.html', '--format', 'json'];
  const first = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const second = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(first.status, 1);
  assert.ok(first.stdout.length > 1000);
  assert.equal(first.stdout, second.stdout);
});


test('explain prints a rule’s doc; an unknown rule exits 2', async () => {
  const r = await run(['explain', 'content/child']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^content\/child · standard · error in strict and standard\n/);
  assert.match(r.stdout, /\nFails:\n {2}<span><div>/);
  const json = await run(['explain', 'style/void-element', '--format', 'json']);
  assert.deepEqual(JSON.parse(json.stdout).severities, { standard: 'off', strict: 'error' });
  const unknown = await run(['explain', 'content/chld']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /did you mean "content\/child"/);
});

test('rules lists every rule with its severity in the profile', async () => {
  const r = await run(['rules', '--profile', 'standard', '--format', 'json']);
  assert.equal(r.code, 0);
  const { profile, rules } = JSON.parse(r.stdout);
  assert.equal(profile, 'standard');
  assert.equal(rules.find((x: { id: string }) => x.id === 'style/attr-quotes').severity, 'off');
  assert.equal(rules.find((x: { id: string }) => x.id === 'content/child').severity, 'error');
  const text = await run(['rules']);
  assert.match(text.stdout, /\n\d+ rules · \d+ on in strict/);
});

test('vocab update writes a snapshot from a checkout; usage errors exit 2', async () => {
  const checkout = join(dir, 'vb');
  mkdirSync(join(checkout, 'src/custom-elements/demo-box'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'vanilla-breeze', version: '9.0.0' }));
  writeFileSync(join(checkout, 'src/custom-elements/demo-box/api.json'), JSON.stringify({ element: 'demo-box', type: 'custom-element', attributes: [] }));
  const out = join(dir, 'snapshot.json');
  const r = await run(['vocab', 'update', 'vanilla-breeze', '--from', checkout, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /: 1 elements? \(1 custom element\) from 1 manifest/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(out, 'utf8')).elements), ['demo-box']);
  assert.equal((await run(['vocab', 'update', 'other', '--from', checkout])).code, 2);
  assert.equal((await run(['vocab', 'update', 'vanilla-breeze'])).code, 2);
});

test('check reads the registry’s elements.json next to the config', async () => {
  const project = join(dir, 'project');
  mkdirSync(join(project, 'registry'), { recursive: true });
  writeFileSync(join(project, 'htmlverify.config.json'), JSON.stringify({ extends: 'standard', registry: 'registry' }));
  writeFileSync(join(project, 'registry/elements.json'), JSON.stringify({ 'app-card': { attributes: { tone: { enum: ['calm'] } } } }));
  writeFileSync(join(project, 'page.html'), '<app-card tone="loud">Hi</app-card>\n');
  const r = await run(['check', join(project, 'page.html'), '--context', 'main', '--config', join(project, 'htmlverify.config.json'), '--format', 'json']);
  const findings = JSON.parse(r.stdout).files[0].findings.map((f: { rule: string }) => f.rule);
  assert.deepEqual(findings, ['component/attribute']);
  writeFileSync(join(project, 'registry/elements.json'), JSON.stringify({ 'layout-stack': {} }));
  const clash = await run(['check', join(project, 'page.html'), '--config', join(project, 'htmlverify.config.json')]);
  assert.equal(clash.code, 2);
  assert.match(clash.stderr, /<layout-stack> is already defined by Vanilla Breeze 0\.3\.1/);
  writeFileSync(join(project, 'htmlverify.config.json'), JSON.stringify({ registry: 'registy' }));
  const typo = await run(['check', join(project, 'page.html'), '--config', join(project, 'htmlverify.config.json')]);
  assert.match(typo.stderr, /"registry" names .*registy, which isn’t a directory/);
});
