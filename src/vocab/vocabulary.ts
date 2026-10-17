// The vocabulary a check runs with: bundled snapshots named by the config,
// the project's elements.json, and the ad-hoc prefix (spec §7.4).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Snapshot, VocabElement } from './types.ts';

export const VOCAB_DIR = fileURLToPath(new URL('../../data/vocab/', import.meta.url));
export const DEFAULT_VOCABULARIES: readonly string[] = ['vanilla-breeze@0.3.1'];
const ID = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/** Snapshot IDs (name@version) bundled in data/vocab. */
export function bundledVocabularies(): string[] {
  if (!existsSync(VOCAB_DIR)) return [];
  return readdirSync(VOCAB_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => ID.test(id)).sort();
}

const snapshots = new Map<string, Snapshot>();

export function loadSnapshot(id: string): Snapshot {
  let snapshot = snapshots.get(id);
  if (!snapshot) {
    if (!ID.test(id) || !bundledVocabularies().includes(id)) throw new RangeError(`no vocabulary snapshot "${id}"`);
    snapshot = JSON.parse(readFileSync(`${VOCAB_DIR}${id}.json`, 'utf8')) as Snapshot;
    snapshots.set(id, snapshot);
  }
  return snapshot;
}

export interface VocabEntry {
  name: string;
  element: VocabElement;
  /** The snapshot ID, or "project" for elements.json. */
  source: string;
}

export class Vocabulary {
  readonly sources: readonly string[];
  readonly adHocPrefix: string | null;
  private readonly entries = new Map<string, VocabEntry>();

  constructor(ids: readonly string[], project: Readonly<Record<string, VocabElement>> | null, adHocPrefix: string | null) {
    for (const id of ids) {
      for (const [name, element] of Object.entries(loadSnapshot(id).elements)) this.entries.set(name, { name, element, source: id });
    }
    for (const [name, element] of Object.entries(project ?? {})) {
      const taken = this.entries.get(name);
      if (taken) throw new RangeError(`<${name}> in the project’s elements.json is already defined by ${Vocabulary.label(taken.source)}`);
      this.entries.set(name, { name, element, source: 'project' });
    }
    this.sources = [...ids, ...(project ? ['project'] : [])];
    this.adHocPrefix = adHocPrefix;
    this.childBooleanNames = new Set([...this.entries.values()].flatMap((e) => e.element.childAttributes.filter((c) => c.type === 'boolean').map((c) => c.name)));
  }

  /** Names of presence booleans that components declare for their children. */
  readonly childBooleanNames: ReadonlySet<string>;

  /** Whether any vocabulary or project element applies; without one, component rules are untested. */
  get configured(): boolean {
    return this.sources.length > 0;
  }

  get(name: string): VocabEntry | null {
    return this.entries.get(name) ?? null;
  }

  /** An undeclared custom element with the ad-hoc prefix. */
  isAdHoc(name: string): boolean {
    return this.adHocPrefix !== null && name.startsWith(this.adHocPrefix) && !this.entries.has(name);
  }

  /** Components whose permittedContent names an undeclared child element, such as page-tour for tour-step. */
  ownersOf(name: string): string[] {
    return [...this.entries.values()].filter((e) => e.element.permittedContent?.includes(name)).map((e) => e.name).sort();
  }

  /** Declared custom elements (web components and custom elements, not native extensions). */
  customNames(): string[] {
    return [...this.entries.values()].filter((e) => e.element.type !== 'native').map((e) => e.name);
  }

  /** A short name for messages: "Vanilla Breeze" or "the project’s elements.json". */
  static label(source: string): string {
    if (source === 'project') return 'the project’s elements.json';
    return source.startsWith('vanilla-breeze@') ? `Vanilla Breeze ${source.slice('vanilla-breeze@'.length)}` : source;
  }
}
