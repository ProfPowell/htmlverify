// Scoring for the evaluation (spec §13): checklists, skeletons, and the
// structural variance between runs.

import { parseHtml } from '../src/parse/parse.ts';
import { childrenOf, isElement, type Element, type Node } from '../src/parse/tree.ts';

export interface ChecklistItem {
  id: string;
  text: string;
  /** CSS-style: lists, descendant and child combinators, tags, [attr], [attr=v], [attr^=v]. */
  selector: string;
  /** Inclusive [min, max]; max null means no limit. */
  count: [number, number | null];
}

export interface Brief {
  id: string;
  type: string;
  title: string;
  content: string;
  checklist: ChecklistItem[];
}

interface Compound {
  tag: string | null;
  attrs: { name: string; op: '' | '=' | '^=' | '$=' | '*='; value: string }[];
}

type Step = { combinator: ' ' | '>'; compound: Compound };

function parseCompound(text: string): Compound {
  const m = /^([a-z][a-z0-9-]*|\*)?((?:\[[^\]]+\])*)$/.exec(text);
  if (!m) throw new Error(`unsupported selector part "${text}"`);
  const attrs = [...(m[2] ?? '').matchAll(/\[([a-z][a-z0-9-]*)(?:([\^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)].map((a) => ({
    name: a[1]!, op: (a[2] ?? '') as Compound['attrs'][number]['op'], value: a[3] ?? a[4] ?? a[5] ?? '',
  }));
  return { tag: m[1] && m[1] !== '*' ? m[1] : null, attrs };
}

function parseSelector(selector: string): Step[][] {
  return selector.split(',').map((one) => {
    const steps: Step[] = [];
    let combinator: Step['combinator'] = ' ';
    for (const token of one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
      if (token === '>') combinator = '>';
      else {
        steps.push({ combinator, compound: parseCompound(token) });
        combinator = ' ';
      }
    }
    return steps;
  });
}

function matchesCompound(e: Element, c: Compound): boolean {
  if (c.tag !== null && e.tagName !== c.tag) return false;
  return c.attrs.every((a) => {
    const v = e.attrs.find((x) => x.name === a.name)?.value;
    if (v === undefined) return false;
    switch (a.op) {
      case '': return true;
      case '=': return v === a.value;
      case '^=': return v.startsWith(a.value);
      case '$=': return v.endsWith(a.value);
      case '*=': return v.includes(a.value);
    }
  });
}

/** Whether e matches the steps, checked right to left through its ancestors. */
function matchesSteps(e: Element, steps: Step[], parents: Map<Element, Element | null>): boolean {
  if (!matchesCompound(e, steps.at(-1)!.compound)) return false;
  let node: Element | null = e;
  for (let i = steps.length - 1; i > 0; i--) {
    const { combinator } = steps[i]!;
    const want = steps[i - 1]!.compound;
    if (combinator === '>') {
      node = parents.get(node!) ?? null;
      if (!node || !matchesCompound(node, want)) return false;
    } else {
      let a: Element | null = parents.get(node!) ?? null;
      while (a && !matchesCompound(a, want)) a = parents.get(a) ?? null;
      if (!a) return false;
      node = a;
    }
  }
  return true;
}

export interface Parsed {
  elements: Element[];
  parents: Map<Element, Element | null>;
  /** Element names in document order: the page's skeleton. */
  skeleton: string[];
}

export function parsePage(html: string): Parsed {
  const root = parseHtml(html, null).root;
  const elements: Element[] = [];
  const parents = new Map<Element, Element | null>();
  const visit = (node: Node, parent: Element | null) => {
    for (const kid of childrenOf(node)) {
      if (!isElement(kid)) continue;
      elements.push(kid);
      parents.set(kid, parent);
      visit(kid, kid);
    }
  };
  visit(root, null);
  return { elements, parents, skeleton: elements.map((e) => e.tagName) };
}

export function countMatches(page: Parsed, selector: string): number {
  const alternatives = parseSelector(selector);
  return page.elements.filter((e) => alternatives.some((steps) => matchesSteps(e, steps, page.parents))).length;
}

export function scoreChecklist(page: Parsed, items: readonly ChecklistItem[]): { id: string; met: boolean; found: number }[] {
  return items.map((item) => {
    const found = countMatches(page, item.selector);
    const [min, max] = item.count;
    return { id: item.id, met: found >= min && (max === null || found <= max), found };
  });
}

/** Levenshtein distance between two skeletons, divided by the longer length. */
export function skeletonDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]! / Math.max(a.length, b.length);
}

/** Mean pairwise distance across runs of one brief and condition; null with fewer than two. */
export function variance(skeletons: readonly (readonly string[])[]): number | null {
  const pairs: number[] = [];
  for (let i = 0; i < skeletons.length; i++) for (let j = i + 1; j < skeletons.length; j++) pairs.push(skeletonDistance(skeletons[i]!, skeletons[j]!));
  return pairs.length ? pairs.reduce((s, x) => s + x, 0) / pairs.length : null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
