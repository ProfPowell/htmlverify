import { appendFile, glob, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, ConfigError, parseConfig, resolveProfile, type Config } from '../config.ts';
import { assemble } from '../assemble/assemble.ts';
import { approveComponent, catalog, checkComponent, checkRegistry, LifecycleError, newComponent, openRegistry, showComponent, STARTER_REGISTRY } from '../assemble/lifecycle.ts';
import { explain, formatExplain, formatRules, listRules } from '../explain.ts';
import { isProfileName, type ProfileName } from '../profiles.ts';
import { canonicalJson, stableJson } from '../report/canonical.ts';
import { fix } from '../fix/fix.ts';
import { unifiedDiff } from '../fix/diff.ts';
import { check, inferContext, type CheckInput, type CheckOptions, type Status } from '../report/report.ts';
import { formatAssembly, formatCatalog, formatComponent, formatComponentCheck, formatRegistryCheck, formatText } from '../report/text.ts';
import { VERSION } from '../version.ts';
import { VocabError } from '../vocab/compile.ts';
import { snapshotFromCheckout } from '../vocab/source.ts';
import { parseElements } from '../vocab/project.ts';
import { init, InitError } from './init.ts';
import { serve } from '../mcp/server.ts';
import { DEFAULT_VOCABULARIES, loadSnapshot, VOCAB_DIR, Vocabulary } from '../vocab/vocabulary.ts';

export interface Io {
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  cwd: string;
}

const USAGE = `Usage:
  htmlverify check <file|glob|->... [--nu] [options]
  htmlverify fix <file|glob|->... [--write] [options]
  htmlverify explain <rule> [--format text|json]
  htmlverify rules [--profile strict|standard] [--config <file>] [--format text|json]
  htmlverify assemble <plan.json|-> [--out <file>] [--emit-failed] [--draft] [options]
  htmlverify catalog [--query <text>] [--format text|json]
  htmlverify component new <id> --author <name>
  htmlverify component show|check <id> [--update] [--nu] [--format text|json]
  htmlverify component approve <id> --by <name> [--nu]
  htmlverify registry check [--nu] [--format text|json]
  htmlverify vocab update vanilla-breeze --from <checkout> [--out <file>]
  htmlverify init [--claude] [--profile strict|standard] [--force]
  htmlverify hook claude                    (the Claude Code PostToolUse hook; reads the event on stdin)
  htmlverify mcp [--draft] [--emit-failed] [--structured]   (the MCP server, on stdin and stdout)

Options:
  --profile strict|standard   rule set (default: the config's "extends", else strict)
  --config <file>             config file (default: the nearest ${CONFIG_FILE})
  --format text|json          output format (default: text)
  --context <tag>             check the input as a fragment inside <tag>
  --stdin-name <path>         path to report for input read from stdin
  --write                     fix: rewrite the files instead of printing a diff
  --out <file>                assemble: write the page there when it passes (default: stdout,
                              with the report on stderr)
  --emit-failed               assemble, mcp: when it fails, write <out>.failed.html to inspect
  --draft                     assemble, mcp: allow unreviewed and stale components, with a warning
  --structured                mcp: also return each result's JSON as structuredContent
  --update                    component check: write each fixture's expected output, to review
  --nu                        check: cross-check documents with the Nu Html Checker (needs Java)
  -h, --help                  show this help
  -v, --version               print the version

Exit codes: 0 pass, 1 fail, 2 usage, config, or input error, 3 incomplete.
`;

const EXIT: Record<Status, number> = { pass: 0, fail: 1, incomplete: 3 };

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof VocabError || error instanceof LifecycleError) {
      io.stderr.write(`htmlverify: ${error.message}\n`);
      return 2;
    }
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`htmlverify: ${error.message}\n\n${USAGE}`);
    return 2;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '-h' || command === '--help' || command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'vocab') return vocab(rest, io);
  if (command === 'init') return initCommand(rest, io);
  if (command === 'hook') return hook(rest, io);
  if (command === 'mcp') return mcpCommand(rest, io);
  if (command === 'assemble') return assembleCommand(rest, io);
  if (command === 'component' || command === 'registry' || command === 'catalog') return lifecycleCommand(command, rest, io);
  if (command !== 'check' && command !== 'fix' && command !== 'explain' && command !== 'rules') {
    throw new UsageError(command ? `unknown command "${command}"` : 'missing command');
  }

  let args: ReturnType<typeof parseCommandArgs>;
  try {
    args = parseCommandArgs(rest);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const { format, context } = args.values;
  if (format !== 'text' && format !== 'json') throw new UsageError(`unknown format "${format}"`);
  const profile = args.values.profile;
  if (profile !== undefined && !isProfileName(profile)) throw new UsageError(`unknown profile "${profile}"`);

  if (command === 'explain') {
    if (args.positionals.length !== 1) throw new UsageError('explain takes one rule, such as content/child');
    let info: ReturnType<typeof explain>;
    try {
      info = explain(args.positionals[0]!);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    io.stdout.write(format === 'json' ? `${canonicalJson(info)}\n` : formatExplain(info));
    return 0;
  }

  const config = await loadConfig(args.values.config, io.cwd);
  if (command === 'rules') {
    if (args.positionals.length > 0) throw new UsageError('rules takes no arguments');
    const resolved = resolveProfile(profile as ProfileName | undefined, config);
    const rows = listRules(resolved);
    io.stdout.write(format === 'json' ? `${canonicalJson({ profile: resolved.name, rules: rows })}\n` : formatRules(rows, resolved));
    return 0;
  }

  if (context !== undefined && !/^[a-z][a-z0-9-]*$/.test(context)) throw new UsageError(`invalid context element "${context}"`);
  if (args.positionals.length === 0) throw new UsageError('no input files');
  const inputs = await readInputs(args.positionals, args.values['stdin-name'], context ?? null, io);
  if (command === 'fix') {
    if (args.values.write && args.positionals.includes('-')) throw new UsageError('--write needs files; stdin can only be diffed');
    return fixFiles(inputs, { profile: profile as ProfileName | undefined, config }, format, args.values.write === true, io);
  }
  if (args.values.write) throw new UsageError('--write applies to fix');
  const nu = args.values.nu ? { jar: config?.nu?.jar ?? resolve(io.cwd, 'node_modules/vnu-jar/build/dist/vnu.jar'), ...(config?.nu?.java ? { java: config.nu.java } : {}) } : null;
  const report = await check(inputs, { profile: profile as ProfileName | undefined, config, nu });
  io.stdout.write(format === 'json' ? `${canonicalJson(report)}\n` : formatText(report));
  return EXIT[report.status];
}

/** `fix`: a unified diff of the tree-preserving fixes, or with --write, the files rewritten in place (spec §8). */
async function fixFiles(inputs: CheckInput[], options: CheckOptions, format: string, write: boolean, io: Io): Promise<number> {
  const results = [];
  for (const input of inputs) results.push(await fix(input, options));
  const reports = results.map((r) => r.report.files[0]!);
  const status: Status = reports.some((f) => f.status === 'incomplete') ? 'incomplete' : reports.some((f) => f.status === 'fail') ? 'fail' : 'pass';
  if (write) {
    for (const r of results) {
      if (r.after === r.before) continue;
      // Atomic: a temporary file beside the original, then a rename over it.
      const target = resolve(io.cwd, r.path);
      const temporary = `${target}.htmlverify-${process.pid}.tmp`;
      await writeFile(temporary, (r.bom ? '\uFEFF' : '') + r.after, { mode: (await stat(target)).mode });
      await rename(temporary, target);
    }
  }
  if (format === 'json') {
    io.stdout.write(`${canonicalJson({
      tool: results[0]?.report.tool,
      profile: results[0]?.report.profile,
      status,
      files: results.map((r) => ({
        path: r.path,
        changed: r.after !== r.before,
        written: write && r.after !== r.before,
        applied: r.applied,
        dropped: r.dropped,
        diff: unifiedDiff(r.path, r.before, r.after),
        report: r.report.files[0]!,
      })),
    })}\n`);
    return EXIT[status];
  }
  for (const r of results) {
    const diff = unifiedDiff(r.path, r.before, r.after);
    if (!write) io.stdout.write(diff);
    const file = r.report.files[0]!;
    const left = file.findings.length === 0 ? 'nothing left to fix by hand' : `${file.summary.errors} error${file.summary.errors === 1 ? '' : 's'} and ${file.summary.warnings} warning${file.summary.warnings === 1 ? '' : 's'} left to fix by hand`;
    const what = r.applied === 0 ? 'no automatic fixes' : `${r.applied} fix${r.applied === 1 ? '' : 'es'} ${write ? 'written' : 'in the diff'}`;
    const summary = `${r.path}: ${what}; ${left}.${r.dropped.length ? ` ${r.dropped.length} fix${r.dropped.length === 1 ? '' : 'es'} would have changed the tree and stay suggestions.` : ''}\n`;
    // The diff is the result; without --write the summary goes to stderr beside it.
    (write ? io.stdout : io.stderr).write(summary);
  }
  return EXIT[status];
}

/**
 * `assemble <plan> [--out file] [--emit-failed] [--draft]` (spec §9.8). The
 * page is written only when it passes. With --out the report goes to stdout;
 * without it the page does, and the report goes to stderr.
 */
async function assembleCommand(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string' },
        'emit-failed': { type: 'boolean' },
        draft: { type: 'boolean' },
        profile: { type: 'string' },
        config: { type: 'string' },
        format: { type: 'string', default: 'text' },
        'stdin-name': { type: 'string', default: '<stdin>' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const { format, profile, out } = args.values;
  if (format !== 'text' && format !== 'json') throw new UsageError(`unknown format "${format}"`);
  if (profile !== undefined && !isProfileName(profile)) throw new UsageError(`unknown profile "${profile}"`);
  if (args.positionals.length !== 1) throw new UsageError('assemble takes one plan, such as plan.json');
  if (args.values['emit-failed'] && out === undefined) throw new UsageError('--emit-failed needs --out to name the failed file');

  const config = await loadConfig(args.values.config, io.cwd);

  const label = (absolute: string) => relative(io.cwd, absolute).split(sep).join('/') || absolute;
  const plan = args.positionals[0]!;
  let text: string;
  let planPath: string;
  if (plan === '-') {
    text = new TextDecoder().decode(await readAll(io.stdin));
    planPath = args.values['stdin-name'];
  } else {
    try {
      text = await readFile(resolve(io.cwd, plan), 'utf8');
    } catch (error) {
      throw new UsageError(`can’t read "${plan}": ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
    planPath = label(resolve(io.cwd, plan));
  }
  const target = out === undefined ? null : resolve(io.cwd, out);
  const result = await assemble(text.replace(/^\uFEFF/, ''), {
    registry: registryFor(config, false), profile: profile as ProfileName | undefined, config, draft: args.values.draft === true, planPath, outPath: target ? label(target) : '<stdout>',
  });

  // Atomic, like fix --write: a temporary file beside the target, then a rename over it.
  const write = async (path: string, html: string) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.htmlverify-${process.pid}.tmp`;
    await writeFile(temporary, html);
    await rename(temporary, path);
    return label(path);
  };
  let written: string | null = null;
  if (result.status === 'pass' && target) written = await write(target, result.html!);
  else if (result.status === 'fail' && target && args.values['emit-failed'] && result.html !== null) {
    written = await write(target.replace(/(?:\.html?)?$/, '.failed.html'), result.html);
  }

  if (format === 'json') {
    const { html, ...rest } = result;
    io.stdout.write(`${canonicalJson({ ...rest, written, ...(target ? {} : { html: result.status === 'pass' ? html : null }) })}\n`);
  } else if (target) {
    io.stdout.write(formatAssembly(result, written));
  } else {
    if (result.status === 'pass') io.stdout.write(result.html!);
    io.stderr.write(formatAssembly(result, result.status === 'pass' ? '<stdout>' : null));
  }
  return result.status === 'pass' ? 0 : 1;
}

/**
 * The component lifecycle (spec §9.10) and the catalog (spec §10.1):
 * `component new|show|check|approve <id>`, `registry check`, and `catalog`,
 * all on the registry the config names.
 */
async function lifecycleCommand(command: 'component' | 'registry' | 'catalog', argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        author: { type: 'string' },
        by: { type: 'string' },
        query: { type: 'string' },
        update: { type: 'boolean' },
        nu: { type: 'boolean' },
        config: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const { format } = args.values;
  if (format !== 'text' && format !== 'json') throw new UsageError(`unknown format "${format}"`);
  const [sub, id, ...extra] = command === 'catalog' ? [undefined, undefined, ...args.positionals] : args.positionals;
  if (extra.length) throw new UsageError(`unexpected argument "${extra[0]}"`);
  const usage: Record<string, string> = {
    component: 'usage: htmlverify component new|show|check|approve <id>',
    registry: 'usage: htmlverify registry check',
  };
  if (command === 'component' && !(['new', 'show', 'check', 'approve'].includes(sub ?? '') && id)) throw new UsageError(usage['component']!);
  if (command === 'registry' && (sub !== 'check' || id)) throw new UsageError(usage['registry']!);
  const allowed: Record<string, readonly string[]> = {
    catalog: ['query'], new: ['author'], show: [], check: ['update', 'nu'], approve: ['by', 'nu'], registry: ['nu'],
  };
  const mode = command === 'component' ? sub! : command;
  for (const option of ['author', 'by', 'query', 'update', 'nu'] as const) {
    if (args.values[option] !== undefined && !allowed[mode]!.includes(option)) throw new UsageError(`--${option} doesn’t apply to ${command === 'component' ? `component ${sub}` : command}`);
  }

  const config = await loadConfig(args.values.config, io.cwd);
  const root = registryFor(config, mode === 'new' || mode === 'approve' || args.values.update === true);
  const json = (value: unknown) => io.stdout.write(`${canonicalJson(value)}\n`);
  if (mode === 'new') {
    if (!args.values.author) throw new UsageError('component new needs --author <name>');
    const files = newComponent(root, id!, args.values.author);
    if (format === 'json') json({ files });
    else io.stdout.write(`${files.map((f) => `wrote ${f}`).join('\n')}\nNext: fill in the contract and template, then run htmlverify component check ${id} --update.\n`);
    return 0;
  }
  const registry = openRegistry(root, config);
  if (mode === 'catalog') {
    const list = catalog(registry, args.values.query);
    if (format === 'json') json(list);
    else io.stdout.write(formatCatalog(list));
    return 0;
  }
  const nu = args.values.nu ? { jar: config?.nu?.jar ?? resolve(io.cwd, 'node_modules/vnu-jar/build/dist/vnu.jar'), ...(config?.nu?.java ? { java: config.nu.java } : {}) } : null;
  if (mode === 'show') {
    const details = await showComponent(registry, id!, { config });
    if (format === 'json') json(details);
    else io.stdout.write(formatComponent(details));
    return 0;
  }
  if (mode === 'check') {
    const result = await checkComponent(registry, id!, { config, nu, update: args.values.update === true });
    if (format === 'json') json(result);
    else io.stdout.write(formatComponentCheck(result));
    return result.status === 'pass' ? 0 : 1;
  }
  if (mode === 'approve') {
    if (!args.values.by) throw new UsageError('component approve needs --by <name>, the reviewer');
    const approval = await approveComponent(registry, id!, args.values.by, { config, nu });
    if (format === 'json') json(approval);
    else {
      io.stdout.write(formatComponentCheck(approval.check));
      io.stdout.write(approval.approved ? `Approved ${id}@${approval.check.version}: the review is recorded in components/${id}/component.json.\n` : `Not approved: ${id} needs a clean check with full coverage first.\n`);
    }
    return approval.approved ? 0 : 1;
  }
  const result = await checkRegistry(registry, { config, nu });
  if (format === 'json') json(result);
  else io.stdout.write(formatRegistryCheck(result));
  return result.status === 'pass' ? 0 : 1;
}

/**
 * The registry the config names, or else the starter registry that ships
 * with htmlverify. That one is read-only once installed: a project writes
 * components into a registry of its own.
 */
function registryFor(config: Config | null, write: boolean): string {
  if (config?.registryDir) return config.registryDir;
  if (write && STARTER_REGISTRY.split(sep).includes('node_modules')) {
    throw new ConfigError(`the starter registry ships with htmlverify and can’t be changed here; set "registry" in ${CONFIG_FILE} to work on your own components`);
  }
  return STARTER_REGISTRY;
}

/** `init [--claude] [--profile] [--force]`: a config, and with --claude the skill and hook (spec §10.4). */
async function initCommand(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: false, strict: true, options: { claude: { type: 'boolean' }, force: { type: 'boolean' }, profile: { type: 'string', default: 'strict' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (!isProfileName(args.values.profile)) throw new UsageError(`unknown profile "${args.values.profile}"`);
  try {
    const lines = await init(io.cwd, { claude: args.values.claude === true, force: args.values.force === true, profile: args.values.profile });
    io.stdout.write(lines.map((l) => `${l}\n`).join(''));
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    io.stderr.write(`htmlverify: ${error.message}\n`);
    return 2;
  }
  return 0;
}

/**
 * `hook claude`: the PostToolUse hook (spec §10.4). It reads the hook event on
 * stdin and checks the .html file the tool wrote. A failing file exits 2 with
 * the report on stderr, which Claude Code hands back to the model; anything
 * else exits 0, and a malformed event exits 1 without blocking.
 */
async function hook(argv: string[], io: Io): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'claude') throw new UsageError('usage: htmlverify hook claude');
  let event: { cwd?: unknown; tool_input?: { file_path?: unknown } };
  try {
    event = JSON.parse(new TextDecoder().decode(await readAll(io.stdin)));
  } catch {
    io.stderr.write('htmlverify hook: the hook input isn’t JSON\n');
    return 1;
  }
  const file = event?.tool_input?.file_path;
  if (typeof file !== 'string' || !/\.(?:html?|xhtml)$/i.test(file)) return 0;
  const cwd = typeof event.cwd === 'string' ? event.cwd : io.cwd;
  const absolute = resolve(cwd, file);
  let source: Uint8Array;
  try {
    source = new Uint8Array(await readFile(absolute));
  } catch {
    return 0; // Deleted or unreadable: nothing to check.
  }
  let config: Config | null;
  try {
    config = await loadConfig(undefined, dirname(absolute));
  } catch (error) {
    io.stderr.write(`htmlverify hook: ${(error as Error).message}\n`);
    return 1;
  }
  // A file that doesn't start as a document is a fragment, checked as body content.
  const context = inferContext(source);
  const path = relative(cwd, absolute).split(sep).join('/') || absolute;
  const report = await check({ path, source, context }, { config });
  // The evaluation harness (eval/run.ts) logs every round and caps the repair loop.
  const log = process.env['HTMLVERIFY_HOOK_LOG'];
  const cap = Number(process.env['HTMLVERIFY_HOOK_MAX_ROUNDS'] ?? Infinity);
  const file0 = report.files[0]!;
  const earlier = log ? await readFile(log, 'utf8').then((t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { file: string; status: string }), () => []) : [];
  const failures = earlier.filter((e) => e.file === absolute && e.status === 'fail').length;
  const capped = report.status === 'fail' && failures >= cap;
  if (log) {
    await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), file: absolute, status: report.status, errors: file0.summary.errors, warnings: file0.summary.warnings, capped })}\n`);
  }
  if (report.status !== 'fail' || capped) return 0;
  const fixCommand = `npx htmlverify fix ${path}${context ? ` --context ${context}` : ''} --write`;
  io.stderr.write(`${formatText(report)}\nhtmlverify: fix these in ${path}. \`${fixCommand}\` applies the mechanical fixes; don't disable rules or invent content to pass.\n`);
  return 2;
}

/**
 * `mcp [--draft] [--emit-failed] [--structured]`: the MCP server (spec §10.3), until stdin
 * closes. The config and registry are read once, at startup. The evaluation
 * harness logs each assembly to HTMLVERIFY_MCP_LOG and caps the repair loop
 * with HTMLVERIFY_MCP_MAX_ROUNDS.
 */
async function mcpCommand(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: false, strict: true, options: { draft: { type: 'boolean' }, 'emit-failed': { type: 'boolean' }, structured: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const config = await loadConfig(args.values.config, io.cwd);
  const rounds = process.env['HTMLVERIFY_MCP_MAX_ROUNDS'];
  await serve(io.stdin, io.stdout, {
    cwd: io.cwd, config, registry: registryFor(config, false), draft: args.values.draft === true, emitFailed: args.values['emit-failed'] === true, structured: args.values.structured === true,
    log: process.env['HTMLVERIFY_MCP_LOG'] ?? null, ...(rounds ? { maxRounds: Number(rounds) } : {}),
  });
  return 0;
}

/** `vocab update vanilla-breeze --from <checkout>`: rebuilds a vocabulary snapshot (spec §3.4). */
async function vocab(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { from: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const [sub, name, ...extra] = args.positionals;
  if (sub !== 'update' || extra.length > 0) throw new UsageError('usage: htmlverify vocab update vanilla-breeze --from <checkout>');
  if (name !== 'vanilla-breeze') throw new UsageError(name ? `unknown vocabulary "${name}"; htmlverify compiles vanilla-breeze` : 'name the vocabulary: vanilla-breeze');
  if (!args.values.from) throw new UsageError('--from <checkout> is required');
  const snapshot = snapshotFromCheckout(resolve(io.cwd, args.values.from));
  const out = args.values.out ? resolve(io.cwd, args.values.out) : join(VOCAB_DIR, `${snapshot.name}@${snapshot.version}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, stableJson(snapshot));
  const counts = new Map<string, number>();
  for (const e of Object.values(snapshot.elements)) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const noun: Record<string, string> = { 'web-component': 'web component', 'custom-element': 'custom element', native: 'native element' };
  const kinds = [...counts].map(([type, n]) => `${n} ${noun[type] ?? type}${n === 1 ? '' : 's'}`).join(', ');
  io.stdout.write(`${relative(io.cwd, out) || out}: ${Object.keys(snapshot.elements).length} elements (${kinds}) from ${snapshot.source.files} manifests${snapshot.source.commit ? ` at ${snapshot.source.commit.slice(0, 7)}` : ''}\n`);
  return 0;
}

function parseCommandArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: 'string' },
      config: { type: 'string' },
      format: { type: 'string', default: 'text' },
      context: { type: 'string' },
      'stdin-name': { type: 'string', default: '<stdin>' },
      write: { type: 'boolean' },
      nu: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/** Reads --config, or the nearest htmlverify.config.json in the working directory or an ancestor. */
async function loadConfig(explicit: string | undefined, cwd: string): Promise<Config | null> {
  const read = async (path: string) => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && explicit === undefined) return undefined;
      throw new UsageError(`can’t read config "${path}": ${code ?? (error as Error).message}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${relative(cwd, path) || path}: invalid JSON: ${(error as Error).message}`);
    }
    const config = parseConfig(json, relative(cwd, path).split(sep).join('/') || CONFIG_FILE);
    if (config.registry !== undefined) {
      config.registryDir = resolve(dirname(path), config.registry);
      config.elements = await loadElements(config.registryDir, config, cwd);
    }
    // Paths in the config are relative to the config file.
    if (config.nu) config.nu = { ...config.nu, jar: resolve(dirname(path), config.nu.jar) };
    return config;
  };
  if (explicit !== undefined) return (await read(resolve(cwd, explicit))) ?? null;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const found = await read(join(dir, CONFIG_FILE));
    if (found !== undefined) return found;
    if (dirname(dir) === dir) return null;
  }
}

/** The registry's elements.json, checked against the configured vocabularies (spec §7.4). */
async function loadElements(registry: string, config: Config, cwd: string): Promise<Config['elements']> {
  const path = join(registry, 'elements.json');
  const label = relative(cwd, path).split(sep).join('/') || path;
  const isDirectory = await stat(registry).then((s) => s.isDirectory(), () => false);
  if (!isDirectory) throw new ConfigError(`"registry" names ${relative(cwd, registry) || registry}, which isn’t a directory`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined; // A registry may have components and no elements of its own.
    throw new ConfigError(`can’t read ${label}: ${code ?? (error as Error).message}`);
  }
  let elements: NonNullable<Config['elements']>;
  try {
    elements = parseElements(JSON.parse(text), label);
  } catch (error) {
    throw new ConfigError(error instanceof SyntaxError ? `${label}: invalid JSON: ${error.message}` : (error as Error).message);
  }
  for (const id of config.vocabularies ?? DEFAULT_VOCABULARIES) {
    const taken = Object.keys(elements).find((name) => loadSnapshot(id).elements[name]);
    if (taken) throw new ConfigError(`${label}: <${taken}> is already defined by ${Vocabulary.label(id)}`);
  }
  return elements;
}

async function readInputs(patterns: string[], stdinName: string, context: string | null, io: Io): Promise<CheckInput[]> {
  const inputs: CheckInput[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (pattern === '-') {
      if (seen.has('-')) throw new UsageError('stdin given more than once');
      seen.add('-');
      inputs.push({ path: stdinName, source: await readAll(io.stdin), context });
      continue;
    }
    const paths: string[] = [];
    if (/[*?[\]{}]/.test(pattern)) {
      for await (const match of glob(pattern, { cwd: io.cwd })) paths.push(resolve(io.cwd, match));
      if (paths.length === 0) throw new UsageError(`no files match "${pattern}"`);
      paths.sort();
    } else paths.push(resolve(io.cwd, pattern));
    for (const absolute of paths) {
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      let source: Uint8Array;
      try {
        source = new Uint8Array(await readFile(absolute));
      } catch (error) {
        throw new UsageError(`can’t read "${pattern}": ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
      inputs.push({ path: relative(io.cwd, absolute).split(sep).join('/'), source, context });
    }
  }
  return inputs;
}

async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
