// The Nu Html Checker cross-check (spec §6.9): one vnu.jar run for every
// document in a check. Nu checks only documents, and only if Java and the jar
// are present; otherwise the cross-check is untested.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NuOptions {
  /** Path to vnu.jar. */
  jar: string;
  /** The java executable; default "java" on the PATH. */
  java?: string;
}

export interface NuMessage {
  severity: 'error' | 'warning' | 'info';
  /** 1-based, in UTF-16 code units, as Nu counts them; a message can span lines, such as a long start tag. */
  line: number;
  column: number;
  endLine: number;
  message: string;
}

export interface NuRun {
  /** Nu's version, such as "26.10.12 (973e40b)"; null when it didn't run. */
  version: string | null;
  /** Messages for each input, by index; empty when it didn't run. */
  messages: NuMessage[][];
  /** Why Nu didn't run, for coverage. */
  unavailable: string | null;
}

interface RawMessage {
  type?: string;
  subType?: string;
  url?: string;
  firstLine?: number;
  lastLine?: number;
  firstColumn?: number;
  lastColumn?: number;
  message?: string;
}

/** Runs Nu once over the documents' bytes, written to a private temporary directory. */
export async function runNu(documents: readonly Uint8Array[], options: NuOptions): Promise<NuRun> {
  const none = (unavailable: string): NuRun => ({ version: null, messages: documents.map(() => []), unavailable });
  if (documents.length === 0) return { version: null, messages: [], unavailable: null };
  if (!existsSync(options.jar)) return none(`vnu.jar isn’t at ${options.jar}`);
  const dir = await mkdtemp(join(tmpdir(), 'htmlverify-nu-'));
  try {
    const files = documents.map((_, i) => join(dir, `${i}.html`));
    await Promise.all(documents.map((bytes, i) => writeFile(files[i]!, bytes)));
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(options.java ?? 'java', ['-jar', options.jar, '--format', 'json', '--stdout', '--exit-zero-always', ...files],
          { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
          (error, out) => (error ? reject(error) : resolve(out)));
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return none(code === 'ENOENT' ? 'Java isn’t installed' : `Nu failed: ${(error as Error).message.split('\n')[0]}`);
    }
    let parsed: { version?: string; messages?: RawMessage[] };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return none('Nu’s output wasn’t JSON');
    }
    const index = new Map(files.map((f, i) => [f, i]));
    const messages: NuMessage[][] = documents.map(() => []);
    for (const m of parsed.messages ?? []) {
      const i = m.url?.startsWith('file:') ? index.get(fileURLToPath(m.url.replace(/^file:(?!\/\/)/, 'file://'))) : undefined;
      if (i === undefined || typeof m.message !== 'string') continue;
      // Nu's info messages with subType "warning" are its warnings; non-document errors are about the run, not the page.
      if (m.type === 'non-document-error') continue;
      const severity = m.type === 'error' ? 'error' : m.subType === 'warning' ? 'warning' : 'info';
      const endLine = m.lastLine ?? m.firstLine ?? 1;
      messages[i]!.push({ severity, line: m.firstLine ?? endLine, column: m.firstColumn ?? m.lastColumn ?? 1, endLine, message: m.message });
    }
    return { version: parsed.version ?? null, messages, unavailable: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
