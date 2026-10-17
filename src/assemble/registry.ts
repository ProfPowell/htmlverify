// The component registry (spec §9.2): <registry>/components/<group>/<name>/
// with component.json, template.html, and fixtures. Loading compiles every
// component and works out its review status from its digest (spec §9.4).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalJson } from '../report/canonical.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import { ContractError, parseContract, type Contract } from './contract.ts';
import { isObject } from './params.ts';
import { compileTemplate, TemplateError, type CompiledTemplate } from './template.ts';

export type ReviewStatus = 'reviewed' | 'stale' | 'unreviewed';

export interface Component {
  id: string;
  dir: string;
  contract: Contract;
  template: CompiledTemplate;
  /** "sha256-…" over the contract without its review, the template, and the fixtures. */
  digest: string;
  status: ReviewStatus;
}

export interface RegistryProblem {
  /** The component directory's ID, which may not be a valid component ID. */
  component: string;
  file: string;
  message: string;
}

export interface Registry {
  root: string;
  components: ReadonlyMap<string, Component>;
  /** Components that failed to load, with every reason. */
  problems: readonly RegistryProblem[];
}

/** Loads every component under `<root>/components`; a missing directory is an empty registry. */
export function loadRegistry(root: string, vocabulary: Vocabulary): Registry {
  const components = new Map<string, Component>();
  const problems: RegistryProblem[] = [];
  const base = join(root, 'components');
  if (!existsSync(base)) return { root, components, problems };
  for (const dir of componentDirs(base)) {
    const id = relative(base, dir).split(sep).join('/');
    const result = loadComponent(dir, id, vocabulary);
    if ('problems' in result) problems.push(...result.problems);
    else components.set(id, result);
  }
  return { root, components, problems };
}

function* componentDirs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory() || entry === 'fixtures') continue;
    if (existsSync(join(path, 'component.json'))) yield path;
    else yield* componentDirs(path);
  }
}

/** Loads one component directory; `id` is its path under components/. */
export function loadComponent(dir: string, id: string, vocabulary: Vocabulary): Component | { problems: RegistryProblem[] } {
  const problems: RegistryProblem[] = [];
  const fail = (file: string, message: string) => problems.push({ component: id, file: join(dir, file), message });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'component.json'), 'utf8'));
  } catch (error) {
    fail('component.json', `isn’t valid JSON: ${(error as Error).message}`);
    return { problems };
  }
  let contract: Contract | null = null;
  try {
    contract = parseContract(raw, join(dir, 'component.json'));
    if (contract.id !== id) fail('component.json', `"id" is "${contract.id}", but the component lives at components/${id}`);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    for (const p of error.problems) fail('component.json', `${p.pointer || '/'}: ${p.message}`);
  }
  const templatePath = join(dir, 'template.html');
  if (!existsSync(templatePath)) fail('template.html', 'is missing');
  if (!contract || problems.length) return { problems };
  const source = readFileSync(templatePath, 'utf8');
  let template: CompiledTemplate;
  try {
    template = compileTemplate(source, contract, vocabulary, templatePath);
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error;
    for (const p of error.problems) fail('template.html', `${p.line}:${p.column}: ${p.message}`);
    return { problems };
  }
  const digest = componentDigest(raw, source, fixtureFiles(dir));
  const review = contract.provenance.review;
  const status: ReviewStatus = review === null ? 'unreviewed' : review.digest === digest ? 'reviewed' : 'stale';
  return { id, dir, contract, template, digest, status };
}

/** The fixtures' files, by name, for the digest. */
export function fixtureFiles(dir: string): [name: string, content: string][] {
  const fixtures = join(dir, 'fixtures');
  if (!existsSync(fixtures)) return [];
  return readdirSync(fixtures).sort().filter((f) => statSync(join(fixtures, f)).isFile()).map((f) => [f, readFileSync(join(fixtures, f), 'utf8')]);
}

/**
 * SHA-256 over the canonical contract without its review, the template, and
 * each fixture by name (spec §9.4), so an approval names this exact version.
 */
export function componentDigest(raw: unknown, template: string, fixtures: readonly [string, string][]): string {
  const contract = isObject(raw) ? { ...raw } : raw;
  if (isObject(contract) && isObject(contract['provenance'])) {
    const { review: _review, ...provenance } = contract['provenance'];
    contract['provenance'] = provenance;
  }
  const hash = createHash('sha256');
  hash.update(`component.json\0${canonicalJson(contract)}\0template.html\0${template}\0`);
  for (const [name, content] of fixtures) hash.update(`fixtures/${name}\0${content}\0`);
  return `sha256-${hash.digest('hex')}`;
}
