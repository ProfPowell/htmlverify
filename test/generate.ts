// Random in-contract plans for the assembler properties (spec §12.3): data
// drawn from pools of realistic values that pass each parameter's own
// validation, slot children whose roots fit where the slot is, and refs to
// instances that have an ID. Seeded, so a failure reproduces from its seed.

import { isPage } from '../src/assemble/contract.ts';
import { misfit, slotAncestors } from '../src/assemble/fit.ts';
import { DEFAULT_SCHEMES, validateValue, type ParamSpec, type Problem, type Value } from '../src/assemble/params.ts';
import type { Component, Registry } from '../src/assemble/registry.ts';
import type { Vocabulary } from '../src/vocab/vocabulary.ts';

/** mulberry32: small, fast, and good enough to pick from pools. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOLS: Record<string, readonly string[]> = {
  text: [
    'Contact us', 'Name', 'Email address', 'Send message', 'Opening hours', 'Fish & chips', '1 < 2 and 3 > 2', 'Say "hello"', 'It’s ready',
    'Café crème', 'Größe', 'Ελληνικά', 'Русский текст', '日本語のテキスト', 'Price: 5 €', 'No break', 'Line one\nline two', 'Tab\tseparated',
    'A longer sentence that keeps going, to see how wrapping and layout behave with real text.', '<b>not markup</b>', '&amp; stays as written',
  ],
  token: ['name', 'email', 'phone', 'first-name', 'q', 'x2', 'message_body', 'Topic', 'ID-7'],
  url: ['/', '/about', '/blog/2026/10/', '/search?q=html&lang=en', 'https://www.w3.org/TR/html/', 'https://developer.mozilla.org/en-US/', 'contact.html', '../index.html', '?page=2', 'mailto:hello@acme.test', 'tel:+15555550100'],
  inline: [
    'Plain words.', 'We <em>never</em> share it.', '<strong>Important</strong>: read this.', 'Use <code>npm test</code> to check.', 'H<sub>2</sub>O and E = mc<sup>2</sup>',
    '<abbr title="HyperText Markup Language">HTML</abbr> rules', 'First<br />second', 'Fish &amp; chips', '<q>Quoted</q> text', 'Due <time datetime="2026-10-17">today</time>',
    '<mark>Marked</mark> words', 'She said <span lang="fr">bonjour</span>.',
  ],
  prose: [
    '<p>One paragraph.</p>', '<p>First.</p><p>Second.</p>', '<ul><li>One</li><li>Two</li></ul>', '<ol start="2"><li>Two</li><li>Three</li></ol>',
    '<h2>Section</h2><p>Text under it.</p>', '<h2>A</h2><p>a</p><h3>B</h3><p>b</p>', '<blockquote><p>A quotation.</p></blockquote>',
    '<dl><dt>Term</dt><dd>Definition.</dd></dl>', '<pre>line one\n  line two</pre>', '<p>See <a href="/about">about us</a>.</p>', '<p>Before.</p><hr /><p>After a break.</p>',
  ],
  datetime: ['2026-10-17', '2026-10-17T14:30', '14:30', '2026-10', '2026-W42', '2026-10-17T14:30:00Z'],
  lang: ['en', 'fr', 'en-GB', 'ja', 'zh-Hant', 'pt-BR'],
};

interface Node {
  use?: string;
  key?: string;
  data?: Record<string, Value>;
  slots?: Record<string, Node[]>;
  html?: string;
}

/** Makes random plans from a registry's components. Returns null for a draw that can't be completed, such as a ref with no target. */
export class PlanGenerator {
  readonly #registry: Registry;
  readonly #vocabulary: Vocabulary;
  readonly #next: () => number;
  readonly #maxDepth: number;
  #refs: { ref: string }[] = [];
  #targets: string[] = [];

  constructor(registry: Registry, vocabulary: Vocabulary, next: () => number, maxDepth = 3) {
    this.#registry = registry;
    this.#vocabulary = vocabulary;
    this.#next = next;
    this.#maxDepth = maxDepth;
  }

  /** A page plan rooted at a random page component. */
  page(): object | null {
    const pages = [...this.#registry.components.values()].filter((c) => isPage(c.contract));
    return pages.length ? this.#draw(() => {
      const root = this.#instance(this.#pick(pages), null, [], [], 0);
      return root && { page: root };
    }) : null;
  }

  /** A fragment plan holding one instance of `component` in its context. */
  fragment(component: Component): object | null {
    const context = component.contract.context;
    return this.#draw(() => {
      const node = this.#instance(component, 'one', [context], [], 0);
      return node && { fragment: { context, children: [node] } };
    });
  }

  /** A few tries at a plan that completes, refs and all. */
  #draw(make: () => object | null): object | null {
    for (let tries = 0; tries < 10; tries++) {
      this.#reset();
      const plan = make();
      if (plan && this.#resolveRefs()) return plan;
    }
    return null;
  }

  #reset(): void {
    this.#refs = [];
    this.#targets = [];
  }

  #pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.#next() * items.length)]!;
  }

  #int(min: number, max: number): number {
    return min + Math.floor(this.#next() * (max - min + 1));
  }

  #instance(component: Component, key: string | null, chain: readonly string[], path: readonly string[], depth: number): Node | null {
    const here = key === null ? path : [...path, key];
    const node: Node = { use: component.id, ...(key === null ? {} : { key }) };
    const data = this.#record(component.contract.params);
    if (!data) return null;
    if (Object.keys(data).length) node.data = data;
    if (key !== null && component.template.symbols.has('')) this.#targets.push(here.join('/'));
    const ancestors = slotAncestors(component.template);
    const slots: Record<string, Node[]> = {};
    let n = 0;
    for (const [name, spec] of Object.entries(component.contract.slots)) {
      const inner = [...chain, ...(ancestors.get(name) ?? [])];
      const leaf = depth + 1 >= this.#maxDepth;
      const candidates = [...this.#registry.components.values()].filter((c) =>
        !isPage(c.contract) && (!spec.accepts || spec.accepts.includes(c.id)) && misfit(c.template, inner, this.#vocabulary) === null
        && (!leaf || Object.values(c.contract.slots).every((s) => s.min === 0)));
      const count = leaf ? spec.min : this.#int(spec.min, Math.min(spec.max ?? 2, Math.max(spec.min, 2)));
      if (count > 0 && !candidates.length) return null;
      const children: Node[] = [];
      for (let i = 0; i < count; i++) {
        const child = this.#instance(this.#pick(candidates), `c${n++}`, inner, here, depth + 1);
        if (!child) return null;
        children.push(child);
      }
      if (children.length) slots[name] = children;
    }
    if (Object.keys(slots).length) node.slots = slots;
    return node;
  }

  /** Values for a record of parameters; optional ones are left out half the time. */
  #record(params: Record<string, ParamSpec>): Record<string, Value> | null {
    const out: Record<string, Value> = {};
    for (const [name, spec] of Object.entries(params)) {
      if (!spec.required && this.#next() < 0.5) continue;
      const v = this.#value(spec);
      if (v === null) return null;
      out[name] = v;
    }
    return out;
  }

  #value(spec: ParamSpec): Value | null {
    const valid = (v: Value) => validateValue(spec, v, '', [] as Problem[], { schemes: DEFAULT_SCHEMES }) !== undefined;
    const from = (pool: readonly string[]) => {
      const ok = pool.filter((v) => valid(v));
      if (!ok.length) throw new Error(`no value in the pool passes ${JSON.stringify(spec)}; add one`);
      return this.#pick(ok);
    };
    switch (spec.type) {
      case 'text':
        return from(spec.pattern ? POOLS['token']! : POOLS['text']!);
      case 'url':
      case 'inline':
      case 'prose':
      case 'datetime':
      case 'lang':
        return from(POOLS[spec.type]!);
      case 'boolean':
        return this.#next() < 0.5;
      case 'enum':
        return this.#pick(spec.values!);
      case 'integer': {
        const min = spec.min ?? 0;
        return this.#int(min, spec.max ?? min + 99);
      }
      case 'ref': {
        const ref = { ref: '' };
        this.#refs.push(ref);
        return ref;
      }
      case 'list': {
        const min = spec.minItems ?? 0;
        const items: Value[] = [];
        for (let i = this.#int(min, Math.min(spec.maxItems ?? 3, Math.max(min, 3))); i > 0; i--) {
          const item = typeof spec.items === 'object' ? this.#record(spec.items) : this.#value({ type: spec.items!, required: true });
          if (item === null) return null;
          items.push(item);
        }
        return items;
      }
    }
  }

  /** Points every ref at an instance with an ID, now that all of them are known. */
  #resolveRefs(): boolean {
    if (this.#refs.length && !this.#targets.length) return false;
    for (const r of this.#refs) r.ref = this.#pick(this.#targets);
    return true;
  }
}
