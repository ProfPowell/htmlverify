// The MCP server (spec §10.3): JSON-RPC 2.0 over stdio, one message per line.
// It's written directly: it needs only initialize, ping, tools/list, and
// tools/call, and each tool wraps a library function. Tools take HTML or a
// plan inline or as a path, so they work without a shared filesystem; paths
// are relative to the server's working directory and can't leave it.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assemble, type AssemblyResult } from '../assemble/assemble.ts';
import { catalog, LifecycleError, openRegistry, showComponent } from '../assemble/lifecycle.ts';
import { isObject } from '../assemble/params.ts';
import { ConfigError, type Config } from '../config.ts';
import { explain, formatExplain } from '../explain.ts';
import { fix } from '../fix/fix.ts';
import type { ProfileName } from '../profiles.ts';
import { canonicalJson } from '../report/canonical.ts';
import { check, inferContext, type Finding } from '../report/report.ts';
import { formatAssembly, formatCatalog, formatComponent, formatText } from '../report/text.ts';
import { words } from '../text.ts';
import { VERSION } from '../version.ts';
import { VocabError } from '../vocab/compile.ts';

/** Newest first. A client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The version that added structuredContent to tool results. */
const STRUCTURED = '2025-06-18';

export interface McpOptions {
  /** The working directory: paths resolve against it and can't leave it. */
  cwd: string;
  config: Config | null;
  /** The registry directory that assemble, list_components, and get_component use. */
  registry: string;
  /** Assemble unreviewed and stale components, with a warning, as `assemble --draft` does. */
  draft?: boolean;
  /** Write a failing assembly's output beside `out`, as name.failed.html. */
  emitFailed?: boolean;
  /** The evaluation's log (eval/run.ts): one JSON line per assembly. */
  log?: string | null;
  /** After this many failing assemblies, each failing result says to stop and report what remains. */
  maxRounds?: number;
  /**
   * Also return each result's JSON as structuredContent. Off by default:
   * Claude Code hands a model the structured content instead of the text,
   * and the text is shorter, says what to do next, and is what §11 is
   * written for.
   */
  structured?: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Property {
  type: 'string' | 'object';
  description: string;
  enum?: readonly string[];
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Property>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; idempotentHint?: boolean; destructiveHint?: boolean; openWorldHint: false };
}

interface ToolResult {
  text: string;
  data: Record<string, unknown>;
}

/** A tool's own error, returned to the model as a result rather than a protocol error, so it can correct the call. */
class ToolError extends Error {}

const HTML_INPUT: Record<string, Property> = {
  html: { type: 'string', description: 'The HTML itself.' },
  path: { type: 'string', description: 'Or the file to read instead, relative to the working directory.' },
};

const TOOLS: Tool[] = [
  {
    name: 'check_html',
    title: 'Check HTML',
    description: 'Check HTML as a browser parses it, against the WHATWG standard, WAI-ARIA, the Vanilla Breeze vocabulary, and the project’s house rules. Give the HTML or a path. Input that starts with a doctype or <html> is a document; anything else is a fragment, checked inside <body> or inside `context`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...HTML_INPUT,
        context: { type: 'string', description: 'For a fragment, the element it goes inside, such as "tbody".' },
        profile: { type: 'string', enum: ['strict', 'standard'], description: 'strict adds the house style and policy rules to standard. Default: the project’s.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'fix_html',
    title: 'Fix HTML',
    description: 'Apply the mechanical fixes (quotes, case, void-element syntax, boolean values, explicit tags, escaping, whitespace) and return the fixed HTML, with what’s left to fix by hand. The fixes never change the parsed tree, and nothing is written.',
    inputSchema: {
      type: 'object',
      properties: { ...HTML_INPUT, context: { type: 'string', description: 'For a fragment, the element it goes inside.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_components',
    title: 'List components',
    description: 'The component catalog, one line per component: its ID and major version, what it’s for, its data, and its slots. In the data, `?` marks an optional parameter, `=a|b` its choices, parentheses a type other than text or a list’s fields, and `[min..max]` a count. Read it before writing a plan.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keep only the components whose ID, summary, or use mentions this.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_component',
    title: 'Get a component',
    description: 'One component in full: each parameter’s type, default, and limits, each slot’s count and the components it takes, an example plan node, and what that renders.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The component ID, such as "form/text-field".' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'assemble',
    title: 'Assemble a page',
    description: [
      'Build a page or a fragment from a plan, check the output, and write it to `out` when it passes.',
      'A plan is JSON: { "page": node }, or { "fragment": { "context": "main", "rank": 1, "children": [node, …] } }.',
      'A node is { "use": "<component ID>", "key": "<name>", "data": { … }, "slots": { "<slot>": [node, …] } }; only the page’s root has no key.',
      'Where no component fits, a node can be { "key": "<name>", "html": "<minimal HTML>" }.',
      'Give the plan, or the path of a plan file.',
      'Each finding names its origin: fix plan findings in the plan, pick other components for composition findings, and report component findings, since the component itself is at fault.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'The plan.' },
        path: { type: 'string', description: 'Or the plan file to read instead, relative to the working directory.' },
        out: { type: 'string', description: 'Where to write the page when it passes, such as "page.html". Without it, the HTML comes back in the result.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'explain_rule',
    title: 'Explain a rule',
    description: 'Why a rule exists, how to fix its findings, and a failing and a passing example.',
    inputSchema: {
      type: 'object',
      properties: { rule: { type: 'string', description: 'The rule ID from a finding, such as "content/child".' } },
      required: ['rule'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const INSTRUCTIONS = `htmlverify builds pages from reviewed components and checks HTML.
To build a page: read list_components, look at the components you'll use with get_component, write a plan with the fewest components that express the content, and run assemble with "out". Fix plan findings in the plan, pick other components for composition findings, and report component findings to the person. Where no component fits, use an HTML node and mention the gap. Stop after 3 failing assemblies, or when the same finding survives two rounds, and report what remains.
To check or fix HTML that's already written: check_html, then fix_html for the mechanical fixes.
Never invent content, such as alt text or labels, to get a pass, and pass review questions on to the person.`;

export class McpServer {
  readonly #options: McpOptions;
  #version: string = PROTOCOL_VERSIONS[0];
  #failures = 0;

  constructor(options: McpOptions) {
    this.#options = options;
  }

  /** Handles one line of input; returns the response to write, or null for a notification. */
  async receive(line: string): Promise<Json | null> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      return failure(null, -32700, `Parse error: ${(error as Error).message}`);
    }
    return this.handle(message);
  }

  async handle(message: unknown): Promise<Json | null> {
    if (Array.isArray(message)) return failure(null, -32600, 'Invalid Request: batches aren’t supported');
    if (!isObject(message) || message['jsonrpc'] !== '2.0') return failure(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 message');
    const id = message['id'];
    const method = message['method'];
    if (typeof method !== 'string') {
      // A response to a request; the server never sends any.
      if ('result' in message || 'error' in message) return null;
      return failure(validId(id), -32600, 'Invalid Request: no method');
    }
    if (id === undefined) return null; // A notification: initialized, cancelled, …
    if (validId(id) === null) return failure(null, -32600, 'Invalid Request: an id must be a string or a number');
    const params = message['params'];
    switch (method) {
      case 'initialize':
        return success(id as string | number, this.#initialize(params));
      case 'ping':
        return success(id as string | number, {});
      case 'tools/list':
        return success(id as string | number, { tools: TOOLS as unknown as Json[] });
      case 'tools/call':
        return this.#call(id as string | number, params);
      default:
        return failure(id as string | number, -32601, `Method not found: ${method}`);
    }
  }

  #initialize(params: unknown): Json {
    const asked = isObject(params) ? params['protocolVersion'] : undefined;
    this.#version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
    return {
      protocolVersion: this.#version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'htmlverify', title: 'htmlverify', version: VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  async #call(id: string | number, params: unknown): Promise<Json> {
    if (!isObject(params) || typeof params['name'] !== 'string') return failure(id, -32602, 'Invalid params: tools/call needs a tool name');
    const tool = TOOLS.find((t) => t.name === params['name']);
    if (!tool) return failure(id, -32602, `Unknown tool: ${params['name']}`);
    const args = params['arguments'] ?? {};
    try {
      if (!isObject(args)) throw new ToolError('the arguments must be an object');
      validate(tool, args);
      const result = await this.#run(tool.name, args);
      const data = JSON.parse(canonicalJson(result.data)) as Json;
      const structured = this.#options.structured === true && this.#version >= STRUCTURED;
      return success(id, { content: [{ type: 'text', text: result.text }], ...(structured ? { structuredContent: data } : {}) });
    } catch (error) {
      const known = error instanceof ToolError || error instanceof LifecycleError || error instanceof ConfigError || error instanceof VocabError;
      const message = error instanceof Error ? error.message : String(error);
      // A bug, not a bad call: say so, and keep the stack for whoever runs the server.
      if (!known) process.stderr.write(`htmlverify mcp: ${tool.name}: ${error instanceof Error ? error.stack ?? message : message}\n`);
      return success(id, { content: [{ type: 'text', text: known ? message : `htmlverify failed: ${message}` }], isError: true });
    }
  }

  async #run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { config } = this.#options;
    switch (name) {
      case 'check_html': {
        const input = await this.#html(args);
        const report = await check(input, { profile: args['profile'] as ProfileName | undefined, config });
        return { text: formatText(report), data: { report } };
      }
      case 'fix_html': {
        const input = await this.#html(args);
        const r = await fix(input, { config });
        const file = r.report.files[0]!;
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        const what = r.applied === 0 ? 'no automatic fixes' : `${count(r.applied, 'fix', 'fixes')} applied`;
        const left = file.findings.length === 0 ? 'nothing left to fix by hand' : `${count(file.summary.errors, 'error', 'errors')} and ${count(file.summary.warnings, 'warning', 'warnings')} left to fix by hand`;
        const dropped = r.dropped.length ? ` ${count(r.dropped.length, 'fix', 'fixes')} would have changed the tree and stay suggestions.` : '';
        const text = [`${r.path}: ${what}; ${left}.${dropped}`, ...(r.after === r.before ? [] : ['', 'Fixed HTML:', r.after.replace(/\n?$/, '')]), ...(file.findings.length ? ['', formatText(r.report).replace(/\n$/, '')] : [])];
        return { text: `${text.join('\n')}\n`, data: { path: r.path, changed: r.after !== r.before, applied: r.applied, dropped: r.dropped, html: r.after, report: r.report } };
      }
      case 'list_components': {
        const list = catalog(this.#registry(), args['query'] as string | undefined);
        const text = list.length ? formatCatalog(list) : `No components match "${args['query']}".\n`;
        return { text, data: { components: list } };
      }
      case 'get_component': {
        const details = await showComponent(this.#registry(), args['id'] as string, { config });
        return { text: formatComponent(details), data: { ...details } };
      }
      case 'assemble':
        return this.#assemble(args);
      case 'explain_rule': {
        let info: ReturnType<typeof explain>;
        try {
          info = explain(args['rule'] as string);
        } catch (error) {
          throw new ToolError((error as Error).message); // An unknown rule, with the nearest one.
        }
        return { text: formatExplain(info), data: { ...info } };
      }
    }
    throw new ToolError(`no tool ${name}`);
  }

  async #html(args: Record<string, unknown>) {
    if ((args['html'] === undefined) === (args['path'] === undefined)) throw new ToolError('give either "html" or "path"');
    const context = args['context'] as string | undefined;
    if (context !== undefined && !/^[a-z][a-z0-9-]*$/.test(context)) throw new ToolError(`"${context}" isn’t an element name`);
    if (typeof args['html'] === 'string') return { path: '<html>', source: args['html'], context: context ?? inferContext(args['html']) };
    const file = this.#inside(args['path'] as string);
    const source = new Uint8Array(await this.#read(file, args['path'] as string));
    return { path: this.#label(file), source, context: context ?? inferContext(source) };
  }

  async #assemble(args: Record<string, unknown>): Promise<ToolResult> {
    const { plan, path, out } = args as { plan?: unknown; path?: string; out?: string };
    if ((plan === undefined) === (path === undefined)) throw new ToolError('give either "plan" or "path"');
    let text: string;
    let planPath: string;
    if (plan !== undefined) {
      // A model sometimes sends the plan as JSON text; take that too.
      text = typeof plan === 'string' ? plan : JSON.stringify(plan, null, 2);
      planPath = '<plan>';
    } else {
      const file = this.#inside(path!);
      text = new TextDecoder().decode(await this.#read(file, path!)).replace(/^﻿/, '');
      planPath = this.#label(file);
    }
    const target = out === undefined ? null : this.#inside(out);
    const result = await assemble(text, {
      registry: this.#registry(), config: this.#options.config, draft: this.#options.draft === true, planPath, outPath: target ? this.#label(target) : '<result>',
    });
    let written: string | null = null;
    if (result.status === 'pass' && target) written = await this.#write(target, result.html!);
    else if (result.status === 'fail' && target && this.#options.emitFailed && result.html !== null) written = await this.#write(target.replace(/(?:\.html?)?$/, '.failed.html'), result.html);
    if (result.status === 'fail') this.#failures++;
    const cap = this.#options.maxRounds ?? Infinity;
    const stop = result.status === 'fail' && this.#failures >= cap
      ? `\nThat makes ${this.#failures} failing ${this.#failures === 1 ? 'assembly' : 'assemblies'}, the most this session allows: stop here, and report what remains to the person.\n`
      : '';
    const html = !target && result.status === 'pass' ? `\nHTML:\n${result.html}` : '';
    if (this.#options.log) await this.#logAssembly(result, planPath, text, written, stop !== '');
    const { html: built, ...rest } = result;
    return { text: formatAssembly(result, written) + html + stop, data: { ...rest, written, ...(target ? {} : { html: result.status === 'pass' ? built : null }) } };
  }

  /** One line per assembly, for eval/run.ts to score: its status, error origins, and gaps, with the plan as sent. */
  async #logAssembly(result: AssemblyResult, path: string, plan: string, written: string | null, capped: boolean): Promise<void> {
    const findings: Finding[] = [...result.plan.findings, ...(result.report?.files[0]?.findings ?? [])];
    const errors = findings.filter((f) => f.severity === 'error');
    // Plan-stage findings are located in the plan; the output's carry their own origin.
    const origins: Record<string, number> = {};
    for (const f of errors) origins[f.origin?.kind ?? 'plan'] = (origins[f.origin?.kind ?? 'plan'] ?? 0) + 1;
    const entry = {
      at: new Date().toISOString(), tool: 'assemble', path, status: result.status, written, capped,
      errors: errors.length, warnings: findings.filter((f) => f.severity === 'warning').length,
      origins, rules: errors.map((f) => f.rule), gaps: result.gaps.length, components: result.components.map((c) => `${c.id}@${c.version}`), plan,
    };
    await mkdir(dirname(this.#options.log!), { recursive: true });
    await appendFile(this.#options.log!, `${JSON.stringify(entry)}\n`);
  }

  #registry() {
    return openRegistry(this.#options.registry, this.#options.config);
  }

  /** The absolute path for `path`, which has to stay inside the working directory. */
  #inside(path: string): string {
    const absolute = resolve(this.#options.cwd, path);
    const rel = relative(this.#options.cwd, absolute);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ToolError(`"${path}" is outside the working directory, ${this.#options.cwd}; use a path inside it`);
    return absolute;
  }

  #label(absolute: string): string {
    return relative(this.#options.cwd, absolute).split(sep).join('/');
  }

  async #read(absolute: string, as: string): Promise<Buffer> {
    try {
      return await readFile(absolute);
    } catch (error) {
      throw new ToolError(`can’t read "${as}": ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }

  /** Atomic, like the CLI's writes: a temporary file beside the target, then a rename over it. */
  async #write(absolute: string, html: string): Promise<string> {
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.htmlverify-${process.pid}.tmp`;
    await writeFile(temporary, html);
    await rename(temporary, absolute);
    return this.#label(absolute);
  }
}

/** Serves one client over a pair of streams until the input ends. */
export async function serve(input: AsyncIterable<string | Uint8Array>, output: { write(chunk: string): unknown }, options: McpOptions): Promise<void> {
  const server = new McpServer(options);
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = async (line: string) => {
    if (!line.trim()) return;
    const response = await server.receive(line);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  };
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      await flush(line);
    }
  }
  await flush(buffer + decoder.decode());
}

function validate(tool: Tool, args: Record<string, unknown>): void {
  const { properties, required = [] } = tool.inputSchema;
  const names = Object.keys(properties);
  for (const key of Object.keys(args)) {
    if (!(key in properties)) throw new ToolError(`${tool.name} has no argument "${key}"; it takes ${words(names.map((n) => `"${n}"`), 'and')}`);
  }
  for (const key of required) if (args[key] === undefined) throw new ToolError(`${tool.name} needs "${key}"`);
  for (const [key, value] of Object.entries(args)) {
    const p = properties[key]!;
    if (value === undefined) continue;
    // The plan may come as JSON text as well as an object.
    const ok = p.type === 'object' ? isObject(value) || (key === 'plan' && typeof value === 'string') : typeof value === 'string';
    if (!ok) throw new ToolError(`"${key}" must be ${p.type === 'object' ? 'an object' : 'a string'}`);
    if (p.enum && !p.enum.includes(value as string)) throw new ToolError(`"${key}" must be ${words(p.enum.map((v) => `"${v}"`))}`);
  }
}

function validId(id: unknown): string | number | null {
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function success(id: string | number, result: Json): Json {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
