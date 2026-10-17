// The evaluation harness (spec §13): conditions A (free-form HTML) and B (with
// the htmlverify check loop), driven by an agent (headless Claude Code) or by
// a person, and scored by htmlverify plus each brief's checklist.
//
//   node eval/run.ts run --briefs home,faq --conditions A,B --runs 3 [--driver agent|human]
//                        [--model claude-sonnet-5-5] [--out eval/results/<name>] [--parallel 2]
//   node eval/run.ts score <out>     # score collected runs, for example after a human driver

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check, parseConfig } from '../src/index.ts';
import { DEFAULT_VOCABULARIES } from '../src/vocab/vocabulary.ts';
import { median, parsePage, scoreChecklist, variance, type Brief } from './lib.ts';

const REPO = resolve(import.meta.dirname, '..');
const BRIEFS = join(REPO, 'eval', 'briefs');
const SKILLS = join(REPO, 'eval', 'skills');
const CONDITIONS = ['A', 'B'] as const;
type Condition = (typeof CONDITIONS)[number];

const PROMPT = `Build the web page described in brief.md as one complete HTML document, saved as page.html in the current directory.
Use the brief's content as given, and don't add other content. Use Vanilla Breeze, its custom elements and data-layout attributes, where it helps; its stylesheet is at /vb/vanilla-breeze.css and its script at /vb/vanilla-breeze.js.
Follow the house skills. When page.html is finished, reply with one line: DONE.`;

const MAX_ROUNDS = 3;

async function loadBriefs(ids: string[] | 'all'): Promise<Brief[]> {
  const all = (await readdir(BRIEFS)).filter((f) => f.endsWith('.json')).sort();
  const briefs = await Promise.all(all.map(async (f) => JSON.parse(await readFile(join(BRIEFS, f), 'utf8')) as Brief));
  if (ids === 'all') return briefs;
  const missing = ids.filter((id) => !briefs.some((b) => b.id === id));
  if (missing.length) throw new Error(`unknown briefs: ${missing.join(', ')}`);
  return ids.map((id) => briefs.find((b) => b.id === id)!);
}

/** A fresh project directory for one run: the brief, the house skills, and for B the check loop. */
async function prepare(dir: string, brief: Brief, condition: Condition): Promise<string> {
  const work = join(dir, 'work');
  await mkdir(join(work, '.claude', 'skills'), { recursive: true });
  await writeFile(join(work, 'brief.md'), `# ${brief.title}\n\nPage type: ${brief.type}\n\n${brief.content}`);
  await cp(SKILLS, join(work, '.claude', 'skills'), { recursive: true });
  await writeFile(join(dir, 'prompt.txt'), `${PROMPT}\n`);
  if (condition === 'B') {
    await cp(join(REPO, 'assets', 'claude', 'SKILL.md'), join(work, '.claude', 'skills', 'htmlverify', 'SKILL.md'));
    await writeFile(join(work, 'htmlverify.config.json'), `${JSON.stringify({ extends: 'strict', vocabularies: DEFAULT_VOCABULARIES }, null, 2)}\n`);
    const command = `node "${join(REPO, 'bin', 'htmlverify.js')}" hook claude`;
    await writeFile(join(work, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command, timeout: 60 }] }] } }, null, 2)}\n`);
    // `npx htmlverify` finds a local bin before the registry.
    const bin = join(work, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'htmlverify'), `#!/bin/sh\nexec node "${join(REPO, 'bin', 'htmlverify.js')}" "$@"\n`);
    await chmod(join(bin, 'htmlverify'), 0o755);
  }
  return work;
}

interface AgentResult {
  ok: boolean;
  error?: string;
  json?: Record<string, unknown>;
  wallMs: number;
}

/** Headless Claude Code in the run's directory, isolated from this session and its MCP servers. */
async function runAgent(dir: string, work: string, condition: Condition, model: string, maxTurns: number, timeoutMinutes: number): Promise<AgentResult> {
  const args = [
    '-p', PROMPT, '--output-format', 'json', '--model', model, '--session-id', randomUUID(), '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--max-turns', String(maxTurns),
    ...(condition === 'B' ? ['--allowedTools', 'Bash(npx htmlverify:*)'] : []),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, HTMLVERIFY_HOOK_LOG: join(dir, 'hook.jsonl'), HTMLVERIFY_HOOK_MAX_ROUNDS: String(MAX_ROUNDS) };
  delete env['CLAUDE_CODE_SESSION_ID'];
  delete env['CLAUDE_CODE_CHILD_SESSION'];
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn('claude', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMinutes * 60_000);
    child.on('close', async (code) => {
      clearTimeout(timer);
      await writeFile(join(dir, 'agent.stderr.txt'), stderr);
      try {
        const json = JSON.parse(stdout) as Record<string, unknown>;
        await writeFile(join(dir, 'agent.json'), `${JSON.stringify(json, null, 2)}\n`);
        done({ ok: code === 0, json, wallMs: Date.now() - started, ...(code === 0 ? {} : { error: `exit ${code}` }) });
      } catch {
        done({ ok: false, error: `exit ${code}; output wasn't JSON`, wallMs: Date.now() - started });
      }
    });
  });
}

interface Score {
  brief: string;
  condition: Condition;
  run: number;
  driver: 'agent' | 'human';
  model: string | null;
  page: boolean;
  status: { first: string | null; final: string | null };
  /** The final page under the standard profile, with the house boolean form allowed: conformance without the house style. */
  standard: { status: string | null; errors: number };
  /** Failing hook checks of page.html; a repair made as several small edits counts each one. */
  rounds: number;
  capped: boolean;
  errors: Record<string, number>;
  warnings: number;
  checklist: { met: number; of: number; items: { id: string; met: boolean; found: number }[] };
  skeleton: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  costUsd: number | null;
  wallMs: number | null;
  turns: number | null;
}

async function score(dir: string, brief: Brief, condition: Condition, run: number): Promise<Score> {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as { driver: Score['driver']; model: string | null; wallMs?: number };
  const pagePath = join(dir, 'work', 'page.html');
  const html = existsSync(pagePath) ? await readFile(pagePath, 'utf8') : null;
  const agent = existsSync(join(dir, 'agent.json')) ? JSON.parse(await readFile(join(dir, 'agent.json'), 'utf8')) as Record<string, unknown> : null;
  const hook = existsSync(join(dir, 'hook.jsonl'))
    ? (await readFile(join(dir, 'hook.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { file: string; status: string; capped: boolean })
      .filter((e) => e.file.endsWith('page.html'))
    : [];
  const report = html === null ? null : (await check({ path: 'page.html', source: html }, { profile: 'strict' })).files[0]!;
  // The house boolean form, required="true", isn't conforming HTML; with booleanValue "true" it's an info note, not an error.
  const conformance = parseConfig({ extends: 'standard', options: { booleanValue: 'true' } }, 'eval');
  const standard = html === null ? null : (await check({ path: 'page.html', source: html }, { config: conformance })).files[0]!;
  const errors: Record<string, number> = {};
  for (const f of report?.findings ?? []) if (f.severity === 'error') errors[f.rule.split('/')[0]!] = (errors[f.rule.split('/')[0]!] ?? 0) + 1;
  const page = html === null ? null : parsePage(html);
  const items = page ? scoreChecklist(page, brief.checklist) : [];
  const usage = agent?.['usage'] as Record<string, number> | undefined;
  const out: Score = {
    brief: brief.id, condition, run, driver: meta.driver, model: meta.model, page: html !== null,
    status: { first: hook[0]?.status ?? report?.status ?? null, final: report?.status ?? null },
    standard: { status: standard?.status ?? null, errors: standard?.summary.errors ?? 0 },
    rounds: hook.filter((e) => e.status === 'fail').length,
    capped: hook.some((e) => e.capped),
    errors, warnings: report?.summary.warnings ?? 0,
    checklist: { met: items.filter((i) => i.met).length, of: brief.checklist.length, items },
    skeleton: page?.skeleton ?? [],
    tokens: usage ? { input: usage['input_tokens'] ?? 0, output: usage['output_tokens'] ?? 0, cacheRead: usage['cache_read_input_tokens'] ?? 0, cacheWrite: usage['cache_creation_input_tokens'] ?? 0 } : null,
    costUsd: typeof agent?.['total_cost_usd'] === 'number' ? agent['total_cost_usd'] as number : null,
    wallMs: meta.wallMs ?? null,
    turns: typeof agent?.['num_turns'] === 'number' ? agent['num_turns'] as number : null,
  };
  await writeFile(join(dir, 'score.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

function summarize(scores: Score[]) {
  const by = (c: Condition) => scores.filter((s) => s.condition === c);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rows = CONDITIONS.filter((c) => by(c).length > 0).map((c) => {
    const runs = by(c);
    const families = [...new Set(runs.flatMap((r) => Object.keys(r.errors)))].sort();
    const briefs = [...new Set(runs.map((r) => r.brief))];
    const variances = briefs.map((b) => variance(runs.filter((r) => r.brief === b).map((r) => r.skeleton))).filter((v): v is number => v !== null);
    return {
      condition: c,
      runs: runs.length,
      passFirst: runs.filter((r) => r.status.first === 'pass').length,
      passFinal: runs.filter((r) => r.status.final === 'pass').length,
      passStandard: runs.filter((r) => r.standard.status === 'pass').length,
      errorsStandard: mean(runs.map((r) => r.standard.errors)),
      capped: runs.filter((r) => r.capped).length,
      medianRounds: median(runs.map((r) => r.rounds)),
      errorsPerPage: Object.fromEntries(families.map((f) => [f, mean(runs.map((r) => r.errors[f] ?? 0))])),
      errorsTotal: mean(runs.map((r) => Object.values(r.errors).reduce((a, b) => a + b, 0))),
      checklist: mean(runs.map((r) => r.checklist.met / Math.max(1, r.checklist.of))),
      variance: mean(variances),
      outputTokens: mean(runs.flatMap((r) => (r.tokens ? [r.tokens.output] : []))),
      costUsd: mean(runs.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))),
      wallSeconds: mean(runs.flatMap((r) => (r.wallMs === null ? [] : [r.wallMs / 1000]))),
    };
  });
  return rows;
}

function markdown(rows: ReturnType<typeof summarize>, scores: Score[], title: string): string {
  const f = (x: number | null, digits = 1) => (x === null ? '–' : x.toFixed(digits));
  const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / Math.max(1, d))}%)`;
  const families = [...new Set(rows.flatMap((r) => Object.keys(r.errorsPerPage)))].sort();
  const lines = [
    `# ${title}`,
    '',
    `Briefs: ${[...new Set(scores.map((s) => s.brief))].join(', ')}. Driver: ${[...new Set(scores.map((s) => s.driver))].join(', ')}. Model: ${[...new Set(scores.map((s) => s.model ?? 'unknown'))].join(', ')}. Scored with htmlverify's strict profile.`,
    '',
    '| Measure | ' + rows.map((r) => `Condition ${r.condition}`).join(' | ') + ' |',
    '| --- | ' + rows.map(() => '---').join(' | ') + ' |',
    '| Runs | ' + rows.map((r) => r.runs).join(' | ') + ' |',
    '| Pass on the first attempt | ' + rows.map((r) => pct(r.passFirst, r.runs)).join(' | ') + ' |',
    '| Pass at the end | ' + rows.map((r) => pct(r.passFinal, r.runs)).join(' | ') + ' |',
    '| Pass at the end, standard profile¹ | ' + rows.map((r) => pct(r.passStandard, r.runs)).join(' | ') + ' |',
    '| Median failing checks | ' + rows.map((r) => f(r.medianRounds)).join(' | ') + ' |',
    '| Runs that hit the cap of 3 | ' + rows.map((r) => r.capped).join(' | ') + ' |',
    '| Errors per page | ' + rows.map((r) => f(r.errorsTotal)).join(' | ') + ' |',
    ...families.map((fam) => `| … ${fam} | ` + rows.map((r) => f(r.errorsPerPage[fam] ?? 0)).join(' | ') + ' |'),
    '| Errors per page, standard profile¹ | ' + rows.map((r) => f(r.errorsStandard)).join(' | ') + ' |',
    '| Checklist met | ' + rows.map((r) => (r.checklist === null ? '–' : `${Math.round(r.checklist * 100)}%`)).join(' | ') + ' |',
    '| Structural variance | ' + rows.map((r) => f(r.variance, 2)).join(' | ') + ' |',
    '| Output tokens | ' + rows.map((r) => f(r.outputTokens, 0)).join(' | ') + ' |',
    '| Cost (USD) | ' + rows.map((r) => (r.costUsd === null ? '–' : `$${r.costUsd.toFixed(2)}`)).join(' | ') + ' |',
    '| Wall time (s) | ' + rows.map((r) => f(r.wallSeconds, 0)).join(' | ') + ' |',
    '',
    '¹ Conformance without the house style: the standard profile, with the house boolean form (`required="true"`) noted rather than counted, since HTML itself allows only `""` or the attribute name.',
    '',
    'Per run:',
    '',
    '| Brief | Condition | Run | First | Final | Standard | Failing checks | Errors | Checklist |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...scores.map((s) => `| ${s.brief} | ${s.condition} | ${s.run} | ${s.status.first ?? '–'} | ${s.status.final ?? 'no page'}${s.capped ? ' (capped)' : ''} | ${s.standard.status ?? '–'} | ${s.rounds} | ${Object.entries(s.errors).map(([k, v]) => `${k} ${v}`).join(', ') || '0'} | ${s.checklist.met}/${s.checklist.of} |`),
    '',
  ];
  return lines.join('\n');
}

async function scoreAll(out: string, title: string): Promise<void> {
  const briefs = await loadBriefs('all');
  const scores: Score[] = [];
  for (const briefId of (await readdir(out, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const brief = briefs.find((b) => b.id === briefId);
    if (!brief) continue;
    for (const run of (await readdir(join(out, briefId))).sort()) {
      const m = /^([AB])-(\d+)$/.exec(run);
      if (m && existsSync(join(out, briefId, run, 'meta.json'))) scores.push(await score(join(out, briefId, run), brief, m[1] as Condition, Number(m[2])));
    }
  }
  const rows = summarize(scores);
  await writeFile(join(out, 'summary.json'), `${JSON.stringify({ rows, runs: scores.map(({ skeleton: _s, ...rest }) => rest) }, null, 2)}\n`);
  await writeFile(join(out, 'summary.md'), markdown(rows, scores, title));
  console.log(markdown(rows, scores, title));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      briefs: { type: 'string', default: 'all' }, conditions: { type: 'string', default: 'A,B' }, runs: { type: 'string', default: '3' },
      driver: { type: 'string', default: 'agent' }, model: { type: 'string', default: 'claude-sonnet-5-5' }, out: { type: 'string' },
      parallel: { type: 'string', default: '2' }, 'max-turns': { type: 'string', default: '40' }, timeout: { type: 'string', default: '20' },
      title: { type: 'string', default: 'Evaluation results' },
    },
  });
  if (command === 'score') {
    const out = resolve(positionals[0] ?? '');
    await scoreAll(out, values.title);
    return;
  }
  if (command !== 'run') throw new Error('usage: node eval/run.ts run|score …');
  const briefs = await loadBriefs(values.briefs === 'all' ? 'all' : values.briefs.split(','));
  const conditions = values.conditions.split(',') as Condition[];
  if (!conditions.every((c) => CONDITIONS.includes(c))) throw new Error('conditions are A and B (C comes with the assembler in M3)');
  const driver = values.driver === 'human' ? 'human' : 'agent';
  const out = resolve(values.out ?? join(REPO, 'eval', 'results', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')));
  const jobs: { brief: Brief; condition: Condition; run: number }[] = [];
  for (const brief of briefs) for (const condition of conditions) for (let run = 1; run <= Number(values.runs); run++) jobs.push({ brief, condition, run });

  const work = async ({ brief, condition, run }: (typeof jobs)[number]) => {
    const dir = join(out, brief.id, `${condition}-${run}`);
    const cwd = await prepare(dir, brief, condition);
    if (driver === 'human') {
      await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ driver, model: null }, null, 2)}\n`);
      await writeFile(join(dir, 'INSTRUCTIONS.md'), `Open Claude Code in ${cwd}${condition === 'B' ? ' with HTMLVERIFY_HOOK_LOG=' + join(dir, 'hook.jsonl') + ' and HTMLVERIFY_HOOK_MAX_ROUNDS=' + MAX_ROUNDS + ' set' : ''}, paste the prompt from prompt.txt, and let it finish. Then run: node eval/run.ts score ${out}\n`);
      return;
    }
    console.error(`run ${brief.id} ${condition}-${run}…`);
    const result = await runAgent(dir, cwd, condition, values.model, Number(values['max-turns']), Number(values.timeout));
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ driver, model: values.model, wallMs: result.wallMs, ok: result.ok, error: result.error ?? null }, null, 2)}\n`);
    console.error(`done ${brief.id} ${condition}-${run}${result.ok ? '' : ` (${result.error})`}`);
  };
  // A small pool: runs are independent, and each one is a separate session.
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await work(job);
  }));
  if (driver === 'agent') await scoreAll(out, values.title);
  else console.log(`Prepared ${jobs.length} runs in ${out}; follow each INSTRUCTIONS.md, then run: node eval/run.ts score ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
