import { glob, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isProfileName } from '../profiles.ts';
import { canonicalJson } from '../report/canonical.ts';
import { check, type CheckInput, type Status } from '../report/report.ts';
import { formatText } from '../report/text.ts';
import { VERSION } from '../version.ts';

export interface Io {
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  cwd: string;
}

const USAGE = `Usage: htmlverify check <file|glob|->... [options]

Options:
  --profile strict|standard   rule set (default: strict)
  --format text|json          output format (default: text)
  --context <tag>             check the input as a fragment inside <tag>
  --stdin-name <path>         path to report for input read from stdin
  -h, --help                  show this help
  -v, --version               print the version

Exit codes: 0 pass, 1 fail, 2 usage or input error, 3 incomplete.
`;

const EXIT: Record<Status, number> = { pass: 0, fail: 1, incomplete: 3 };

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
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
  if (command !== 'check') throw new UsageError(command ? `unknown command "${command}"` : 'missing command');

  let args: ReturnType<typeof parseCheckArgs>;
  try {
    args = parseCheckArgs(rest);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (args.values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  const { profile, format, context } = args.values;
  if (!isProfileName(profile)) throw new UsageError(`unknown profile "${profile}"`);
  if (format !== 'text' && format !== 'json') throw new UsageError(`unknown format "${format}"`);
  if (context !== undefined && !/^[a-z][a-z0-9-]*$/.test(context)) throw new UsageError(`invalid context element "${context}"`);
  if (args.positionals.length === 0) throw new UsageError('no input files');

  const inputs = await readInputs(args.positionals, args.values['stdin-name'], context ?? null, io);
  const report = await check(inputs, { profile });
  io.stdout.write(format === 'json' ? `${canonicalJson(report)}\n` : formatText(report));
  return EXIT[report.status];
}

function parseCheckArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: 'string', default: 'strict' },
      format: { type: 'string', default: 'text' },
      context: { type: 'string' },
      'stdin-name': { type: 'string', default: '<stdin>' },
      help: { type: 'boolean', short: 'h' },
    },
  });
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
