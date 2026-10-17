import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { main } from '../src/cli/main.ts';
import { check, parseConfig, resolveProfile } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'htmlverify-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], cwd: string) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdin: (async function* () {})(),
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    cwd,
  });
  return { code, stdout, stderr };
}

test('parseConfig rejects unknown keys, rules, severities, and options', () => {
  const cases: [unknown, RegExp][] = [
    [[], /must be a JSON object/],
    [{ extend: 'strict' }, /unknown key "extend"/],
    [{ extends: 'loose' }, /"extends" must be/],
    [{ rules: { 'content/childs': 'off' } }, /unknown rule "content\/childs"/],
    [{ rules: { 'content/child': 'warn' } }, /must be "error", "warning", "info", or "off"/],
    [{ rules: { 'content/child': ['warning', {}] } }, /takes no options/],
    [{ options: { voidElements: 'xml' } }, /"options.voidElements" must be/],
    [{ options: { quotes: 'double' } }, /unknown option "quotes"/],
    [{ maxWarnings: -1 }, /"maxWarnings" must be/],
    [{ vocabularies: ['vanilla-breeze@0.3.1'] }, /isn’t supported yet \(M1d\)/],
    [{ options: { linkTextLanguage: 'fr' } }, /"options.linkTextLanguage" must be "en"/],
    [{ options: { adHocPrefix: 'x-' } }, /isn’t supported yet \(M1d\)/],
  ];
  for (const [raw, error] of cases) assert.throws(() => parseConfig(raw, 'test.json'), error, JSON.stringify(raw));
});

test('a config overrides the base profile’s severities, options, and warning limit', async () => {
  const config = parseConfig({ extends: 'standard', rules: { 'style/void-element': 'warning' }, options: { voidElements: 'html' }, maxWarnings: 0 }, 'test.json');
  const profile = resolveProfile(undefined, config);
  assert.equal(profile.name, 'standard');
  assert.equal(profile.severities['style/void-element'], 'warning');
  assert.equal(profile.options.voidElements, 'html');
  const report = await check({ path: 'a.html', source: '<p>a<br />b</p>', context: 'div' }, { config });
  const [file] = report.files;
  assert.deepEqual(file!.findings.map((f) => `${f.rule} ${f.severity}`), ['style/void-element warning']);
  assert.equal(file!.status, 'fail', 'one warning exceeds maxWarnings 0');
  const plain = await check({ path: 'a.html', source: '<p>a<br />b</p>', context: 'div' }, { profile: 'standard' });
  assert.notEqual(report.profile.hash, plain.profile.hash, 'the config changes the profile hash');
});

test('the CLI finds the nearest config, takes --config, and reports config errors with exit 2', async () => {
  const project = join(dir, 'project');
  const nested = join(project, 'pages', 'deep');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'page.html'), '<p class=x>Text</p>\n');
  writeFileSync(join(project, 'htmlverify.config.json'), JSON.stringify({ extends: 'standard' }));
  assert.equal((await run(['check', 'page.html', '--context', 'div'], nested)).code, 0, 'standard ignores the unquoted value');
  assert.equal((await run(['check', 'page.html', '--context', 'div', '--profile', 'strict'], nested)).code, 1, '--profile overrides extends');

  writeFileSync(join(project, 'strict.json'), JSON.stringify({ extends: 'strict' }));
  assert.equal((await run(['check', 'pages/deep/page.html', '--context', 'div', '--config', 'strict.json'], project)).code, 1);

  writeFileSync(join(project, 'bad.json'), '{ "rules": { "nope/rule": "off" } }');
  const bad = await run(['check', 'pages/deep/page.html', '--config', 'bad.json'], project);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^htmlverify: bad\.json: unknown rule "nope\/rule"/);

  writeFileSync(join(project, 'broken.json'), '{ "rules": ');
  const broken = await run(['rules', '--config', 'broken.json'], project);
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /invalid JSON/);

  const missing = await run(['rules', '--config', 'absent.json'], project);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /can’t read config/);
});
