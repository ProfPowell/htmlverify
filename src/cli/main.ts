import { glob, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, ConfigError, parseConfig, resolveProfile, type Config } from '../config.ts';
import { explain, formatExplain, formatRules, listRules } from '../explain.ts';
import { isProfileName, type ProfileName } from '../profiles.ts';
import { canonicalJson, stableJson } from '../report/canonical.ts';
import { check, type CheckInput, type Status } from '../report/report.ts';
import { formatText } from '../report/text.ts';
import { VERSION } from '../version.ts';
import { VocabError } from '../vocab/compile.ts';
import { snapshotFromCheckout } from '../vocab/source.ts';
import { parseElements } from '../vocab/project.ts';
import { DEFAULT_VOCABULARIES, loadSnapshot, VOCAB_DIR, Vocabulary } from '../vocab/vocabulary.ts';

export interface Io {
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  cwd: string;
}

const USAGE = `Usage:
  htmlverify check <file|glob|->... [options]
  htmlverify explain <rule> [--format text|json]
  htmlverify rules [--profile strict|standard] [--config <file>] [--format text|json]
  htmlverify vocab update vanilla-breeze --from <checkout> [--out <file>]

Options:
  --profile strict|standard   rule set (default: the config's "extends", else strict)
  --config <file>             config file (default: the nearest ${CONFIG_FILE})
  --format text|json          output format (default: text)
  --context <tag>             check the input as a fragment inside <tag>
  --stdin-name <path>         path to report for input read from stdin
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
    if (error instanceof ConfigError || error instanceof VocabError) {
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
  if (command !== 'check' && command !== 'explain' && command !== 'rules') {
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
  const report = await check(inputs, { profile: profile as ProfileName | undefined, config });
  io.stdout.write(format === 'json' ? `${canonicalJson(report)}\n` : formatText(report));
  return EXIT[report.status];
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
    if (config.registry !== undefined) config.elements = await loadElements(resolve(dirname(path), config.registry), config, cwd);
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
