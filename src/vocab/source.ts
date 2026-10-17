// Reads Vanilla Breeze's manifests from a checkout for `vocab update` (spec
// §3.4). The checkout is data: nothing in it runs, and git isn't invoked.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileSnapshot, VocabError, type Manifest } from './compile.ts';
import type { Snapshot } from './types.ts';

/** Where the registry builder looks, in its order: component folders, then the overrides file. */
const MANIFEST_DIRS = ['src/web-components', 'src/custom-elements'];
const OVERRIDES = 'src/htmlvalidate/api-overrides.json';

export function snapshotFromCheckout(dir: string): Snapshot {
  const root = resolve(dir);
  const paths: string[] = [];
  for (const base of MANIFEST_DIRS) {
    const full = join(root, base);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full).sort()) {
      const path = join(full, entry, 'api.json');
      if (existsSync(path) && statSync(path).isFile()) paths.push(path);
    }
  }
  if (existsSync(join(root, OVERRIDES))) paths.push(join(root, OVERRIDES));
  if (paths.length === 0) {
    throw new VocabError([`${dir}: no api.json manifests under src/; --from takes a Vanilla Breeze checkout (the npm package doesn’t ship its manifests)`]);
  }

  const pkg = readJson(join(root, 'package.json'), 'package.json');
  if (pkg['name'] !== 'vanilla-breeze') throw new VocabError([`${dir}: package.json names "${String(pkg['name'])}", not vanilla-breeze`]);
  if (typeof pkg['version'] !== 'string') throw new VocabError([`${dir}: package.json has no version`]);

  const hash = createHash('sha256');
  const manifests: Manifest[] = [];
  const problems: string[] = [];
  for (const path of paths) {
    const rel = relative(root, path).split(sep).join('/');
    const bytes = readFileSync(path);
    hash.update(rel).update('\0').update(bytes).update('\0');
    try {
      manifests.push({ path: rel, json: JSON.parse(bytes.toString('utf8')) });
    } catch (error) {
      problems.push(`${rel}: invalid JSON (${(error as Error).message})`);
    }
  }
  if (problems.length > 0) throw new VocabError(problems);

  const repository = pkg['repository'];
  const url = typeof repository === 'string' ? repository : isRecord(repository) && typeof repository['url'] === 'string' ? repository['url'] : 'https://github.com/profpowell/vanilla-breeze';
  return compileSnapshot(manifests, {
    version: pkg['version'],
    repo: url.replace(/^git\+/, '').replace(/\.git$/, ''),
    commit: gitCommit(root),
    sha256: hash.digest('hex'),
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new VocabError([`can’t read ${label}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`]);
  }
  if (!isRecord(value)) throw new VocabError([`${label} isn’t a JSON object`]);
  return value;
}

/** The commit HEAD points at, read from .git without running git; null outside a checkout. */
export function gitCommit(root: string): string | null {
  let gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return null;
  if (statSync(gitDir).isFile()) {
    // A worktree or submodule: ".git" names the real directory.
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
    if (!pointer) return null;
    gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
  }
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
  const head = read(join(gitDir, 'HEAD'));
  if (!head) return null;
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const common = read(join(gitDir, 'commondir'));
  const dirs = [gitDir, ...(common ? [resolve(gitDir, common)] : [])];
  for (const d of dirs) {
    const loose = read(join(d, ...ref.split('/')));
    if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  }
  for (const d of dirs) {
    for (const line of (read(join(d, 'packed-refs')) ?? '').split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
  }
  return null;
}

