import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { McpServer, PROTOCOL_VERSIONS, serve, type McpOptions } from '../src/mcp/server.ts';

/*
 * The MCP server (spec §10.3): the JSON-RPC exchange, each tool against
 * test/registry, the evaluation's log and repair cap, and `htmlverify mcp`
 * over real stdio with the starter registry.
 */

const ROOT = join(import.meta.dirname, '..');
const REGISTRY = join(import.meta.dirname, 'registry');
const dir = mkdtempSync(join(tmpdir(), 'htmlverify-mcp-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const PROSE = { fragment: { context: 'main', children: [{ use: 'content/prose', key: 'intro', data: { html: '<p>We reply within a day.</p>' } }] } };

interface Response {
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface CallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A server in a working directory of its own, initialized at `version`, drafting since the test components are unreviewed, and returning JSON too. */
async function server(options: Partial<McpOptions> = {}, version: string = PROTOCOL_VERSIONS[0]) {
  const cwd = mkdtempSync(join(dir, 'cwd-'));
  const s = new McpServer({ cwd, config: null, registry: REGISTRY, draft: true, structured: true, ...options });
  await s.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  let id = 1;
  const call = async (name: string, args: unknown): Promise<CallResult> => {
    const response = (await s.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as unknown as Response;
    assert.equal(response.error, undefined, response.error?.message);
    return response.result as unknown as CallResult;
  };
  return { s, cwd, call, text: (r: CallResult) => r.content.map((c) => c.text).join('') };
}

test('initialize negotiates the protocol version, and tools/list lists the six tools', async () => {
  const s = new McpServer({ cwd: dir, config: null, registry: REGISTRY });
  const init = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as unknown as Response;
  assert.equal(init.result!['protocolVersion'], '2025-06-18');
  assert.deepEqual(init.result!['capabilities'], { tools: { listChanged: false } });
  assert.match(String(init.result!['instructions']), /list_components.*get_component.*assemble/s);
  const newer = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as unknown as Response;
  assert.equal(newer.result!['protocolVersion'], PROTOCOL_VERSIONS[0]);
  const list = (await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as unknown as Response;
  const tools = list.result!['tools'] as { name: string; description: string; inputSchema: { type: string; additionalProperties: boolean } }[];
  assert.deepEqual(tools.map((t) => t.name), ['check_html', 'fix_html', 'list_components', 'get_component', 'assemble', 'explain_rule']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(t.description.length > 40, t.name);
  }
});

test('protocol errors: bad JSON, batches, unknown methods and tools; notifications and responses get no answer', async () => {
  const s = new McpServer({ cwd: dir, config: null, registry: REGISTRY });
  assert.deepEqual(await s.receive('not json'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: Unexpected token \'o\', "not json" is not valid JSON' } });
  assert.equal(((await s.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])) as unknown as Response).error?.code, -32600);
  assert.equal(((await s.handle({ id: 1, method: 'ping' })) as unknown as Response).error?.code, -32600);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 'a', method: 'ping' }), { jsonrpc: '2.0', id: 'a', result: {} });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }), { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/list' } });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } }), { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unknown tool: nope' } });
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await s.handle({ jsonrpc: '2.0', id: 4, result: {} }), null);
});

test('arguments are checked, and a bad call is a tool error the model can correct', async () => {
  const { call, text } = await server();
  const cases: [string, unknown, RegExp][] = [
    ['check_html', { htm: '<p>x</p>' }, /^check_html has no argument "htm"; it takes "html", "path", "context", and "profile"$/],
    ['check_html', { html: 1 }, /^"html" must be a string$/],
    ['check_html', { html: '<p>x</p>', profile: 'loose' }, /^"profile" must be "strict" or "standard"$/],
    ['check_html', {}, /^give either "html" or "path"$/],
    ['check_html', { html: '<p>x</p>', context: 'Body' }, /^"Body" isn’t an element name$/],
    ['get_component', {}, /^get_component needs "id"$/],
    ['assemble', { plan: [] }, /^"plan" must be an object$/],
    ['assemble', [], /^the arguments must be an object$/],
  ];
  for (const [name, args, message] of cases) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(text(r), message);
  }
});

test('check_html infers a fragment, reads paths inside the working directory, and refuses paths outside it', async () => {
  const { cwd, call, text } = await server();
  const fragment = await call('check_html', { html: '<p>Hi<br></p>\n' });
  assert.equal(fragment.isError, undefined);
  assert.match(text(fragment), /^<html>\n.*style\/void-element +Write void elements as <br \/>\./ms);
  const report = fragment.structuredContent!['report'] as { status: string; files: { kind: string; path: string }[] };
  assert.equal(report.status, 'fail');
  assert.equal(report.files[0]!.kind, 'fragment');

  mkdirSync(join(cwd, 'site'));
  copyFileSync(join(ROOT, 'test/fixtures/syntax/doctype/pass.html'), join(cwd, 'site', 'page.html'));
  const document = await call('check_html', { path: 'site/page.html', profile: 'standard' });
  const files = (document.structuredContent!['report'] as typeof report).files;
  assert.deepEqual([files[0]!.kind, files[0]!.path], ['document', 'site/page.html']);
  assert.match(text(document), /✓ pass .* standard/);

  for (const path of ['../page.html', '/etc/hostname', '.']) {
    const r = await call('check_html', { path });
    assert.equal(r.isError, true, path);
    assert.match(text(r), /is outside the working directory/);
  }
  const missing = await call('check_html', { path: 'gone.html' });
  assert.deepEqual([missing.isError, text(missing)], [true, 'can’t read "gone.html": ENOENT']);
});

test('fix_html returns the fixed HTML and what’s left to fix by hand, and writes nothing', async () => {
  const { cwd, call, text } = await server();
  writeFileSync(join(cwd, 'card.html'), '<p class=card>Hi<br></p>\n');
  const r = await call('fix_html', { path: 'card.html' });
  assert.match(text(r), /^card\.html: 2 fixes applied; 0 errors and 1 warning left to fix by hand\.\n\nFixed HTML:\n<p class="card">Hi<br \/><\/p>\n\ncard\.html\n.*semantic\/br-spacing/s);
  assert.equal(r.structuredContent!['html'], '<p class="card">Hi<br /></p>\n');
  assert.equal(r.structuredContent!['changed'], true);
  assert.equal(readFileSync(join(cwd, 'card.html'), 'utf8'), '<p class=card>Hi<br></p>\n');
  const clean = await call('fix_html', { html: '<p class="card">Hi</p>\n' });
  assert.equal(text(clean), '<html>: no automatic fixes; nothing left to fix by hand.\n');
});

test('list_components and get_component read the registry, and an unknown ID names the nearest', async () => {
  const { call, text } = await server();
  const all = await call('list_components', {});
  assert.match(text(all), /^action\/jump@1 /m);
  assert.ok((all.structuredContent!['components'] as { id: string }[]).some((c) => c.id === 'form/text-field'));
  assert.equal(text(await call('list_components', { query: 'carousel' })), 'No components match "carousel".\n');
  const one = await call('get_component', { id: 'form/text-field' });
  assert.match(text(one), /^form\/text-field@1\.0\.0 · unreviewed/);
  assert.equal((one.structuredContent!['contract'] as { id: string }).id, 'form/text-field');
  const typo = await call('get_component', { id: 'form/text-feld' });
  assert.equal(typo.isError, true);
  assert.match(text(typo), /there’s no component form\/text-feld in .*; did you mean form\/text-field\?/);
});

test('assemble returns the HTML without "out", and with it writes the page only when it passes', async () => {
  const { cwd, call, text } = await server();
  const inline = await call('assemble', { plan: PROSE });
  assert.equal(inline.structuredContent!['status'], 'pass');
  assert.match(text(inline), /✓ pass · wrote nothing · 1 component · 0 gaps\n\nHTML:\n<layout-stack>\n {2}<p>We reply within a day\.<\/p>\n<\/layout-stack>\n$/);
  const html = inline.structuredContent!['html'] as string;

  writeFileSync(join(cwd, 'plan.json'), JSON.stringify(PROSE, null, 2));
  const file = await call('assemble', { path: 'plan.json', out: 'site/page.html' });
  assert.equal(file.structuredContent!['written'], 'site/page.html');
  assert.equal('html' in file.structuredContent!, false);
  assert.equal(readFileSync(join(cwd, 'site/page.html'), 'utf8'), html);
  assert.match(text(file), /^plan\.json\n/);

  // A plan sent as JSON text is taken too; its findings are located in that text.
  const typo = JSON.stringify({ fragment: { ...PROSE.fragment, children: [{ ...PROSE.fragment.children[0], dta: {} }] } });
  const bad = await call('assemble', { plan: typo, out: 'other.html' });
  assert.equal(bad.structuredContent!['status'], 'fail');
  assert.match(text(bad), /error +assembly\/plan +\/fragment\/children\/0\/dta: unknown property "dta"/);
  assert.equal(existsSync(join(cwd, 'other.html')), false);
});

test('a failing assembly can leave name.failed.html; each one is logged, and past the cap the result says to stop', async () => {
  // A component whose button has no type: the output check blames the component.
  const registry = join(dir, 'broken-registry');
  const box = join(registry, 'components', 'test', 'box');
  mkdirSync(box, { recursive: true });
  writeFileSync(join(box, 'component.json'), JSON.stringify({ id: 'test/box', version: '1.0.0', summary: 'A box.', use: 'Tests.', params: { text: { type: 'text' } }, provenance: { authors: ['htmlverify tests'], aiAssisted: false } }));
  writeFileSync(join(box, 'template.html'), '<button>{{text}}</button>\n');
  const log = join(dir, 'mcp.jsonl');
  const { cwd, call, text } = await server({ registry, emitFailed: true, log, maxRounds: 2 });
  const plan = { fragment: { context: 'main', children: [{ use: 'test/box', key: 'box', data: { text: 'Inside.' } }] } };

  const first = await call('assemble', { plan, out: 'page.html' });
  assert.equal(first.structuredContent!['status'], 'fail');
  assert.equal(first.structuredContent!['written'], 'page.failed.html');
  assert.equal(existsSync(join(cwd, 'page.html')), false);
  assert.equal(readFileSync(join(cwd, 'page.failed.html'), 'utf8'), '<button>Inside.</button>\n');
  assert.match(text(first), /error +policy\/button-type .*\[component: \/fragment\/children\/0 · test\/box@1\.0\.0 template\.html:1:1\]/);
  assert.doesNotMatch(text(first), /stop here/);
  const second = await call('assemble', { plan, out: 'page.html' });
  assert.match(text(second), /\nThat makes 2 failing assemblies, the most this session allows: stop here, and report what remains to the person\.\n$/);

  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map((l) => [l['tool'], l['status'], l['written'], l['capped'], l['origins'], l['rules'], l['gaps'], l['components']]), [
    ['assemble', 'fail', 'page.failed.html', false, { component: 1 }, ['policy/button-type'], 0, ['test/box@1.0.0']],
    ['assemble', 'fail', 'page.failed.html', true, { component: 1 }, ['policy/button-type'], 0, ['test/box@1.0.0']],
  ]);
  assert.equal(lines[0]!['plan'], JSON.stringify(plan, null, 2));
});

test('explain_rule explains a rule, and an unknown one names the nearest', async () => {
  const { call, text } = await server();
  const r = await call('explain_rule', { rule: 'content/child' });
  assert.match(text(r), /^content\/child · standard/);
  assert.equal((r.structuredContent as { id: string }).id, 'content/child');
  const typo = await call('explain_rule', { rule: 'content/chld' });
  assert.deepEqual([typo.isError, text(typo)], [true, 'unknown rule "content/chld"; did you mean "content/child"?']);
});

test('structuredContent comes only when asked for, and only with protocol versions that have it', async () => {
  for (const [options, version] of [[{ structured: false }, PROTOCOL_VERSIONS[0]], [{}, '2025-03-26']] as const) {
    const { call } = await server(options, version);
    const r = await call('list_components', {});
    assert.equal('structuredContent' in r, false, version);
    assert.match(r.content[0]!.text, /^action\/jump@1 /);
  }
});

test('serve answers line by line, across chunk boundaries and a last line without a newline', async () => {
  const chunks = ['{"jsonrpc":"2.0","id":1,"method":"pi', 'ng"}\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}'];
  let out = '';
  await serve((async function* () {
    yield* chunks;
  })(), { write: (s: string) => (out += s) }, { cwd: dir, config: null, registry: REGISTRY });
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
});

test('htmlverify mcp serves over stdio, with the starter registry when the config names none', () => {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_components', arguments: { query: 'dialog' } } },
  ].map((m) => JSON.stringify(m)).join('\n');
  const cwd = mkdtempSync(join(dir, 'stdio-'));
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'htmlverify.js'), 'mcp', '--draft', '--structured'], { cwd, input: `${lines}\n`, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const responses = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Response);
  assert.deepEqual(responses.map((m) => m.id), [1, 2]);
  assert.equal(responses[0]!.result!['protocolVersion'], '2025-06-18');
  const ids = ((responses[1]!.result!['structuredContent'] as { components: { id: string }[] }).components).map((c) => c.id);
  assert.deepEqual(ids, ['action/button', 'dialog/modal']);
});
