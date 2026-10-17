// The selectors manifests use to name children ("li", "button | a",
// "input[type=checkbox]", "any child"), and the hand-written structure
// requirements: compound selectors only, in a list.

import type { Element } from '../parse/tree.ts';
import { attr } from '../spec/model.ts';

interface Compound {
  tag: string | null;
  attrs: { name: string; value: string | null }[];
  classes: string[];
}

export type Selector = readonly Compound[];

const COMPOUND = /^([a-z][a-z0-9-]*|\*)?((?:\[[a-z][a-z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\]"']*))?\]|\.[a-zA-Z0-9_-]+)*)$/;

/** Parses "a, b | c[x=y]"; null when any part isn't a compound selector. */
export function parseSelector(source: string): Selector | null {
  const text = source.trim();
  if (/^any (?:child|element)s?$/i.test(text)) return [{ tag: null, attrs: [], classes: [] }];
  const out: Compound[] = [];
  for (const part of text.split(/\s*(?:,|\||\bor\b)\s*/)) {
    const m = COMPOUND.exec(part.trim());
    if (!m || part.trim() === '') return null;
    const compound: Compound = { tag: m[1] && m[1] !== '*' ? m[1] : null, attrs: [], classes: [] };
    for (const [, name, value, cls] of (m[2] ?? '').matchAll(/\[([a-z][a-z0-9-]*)(?:=("[^"]*"|'[^']*'|[^\]"']*))?\]|\.([a-zA-Z0-9_-]+)/g)) {
      if (cls) compound.classes.push(cls);
      else compound.attrs.push({ name: name!, value: value === undefined ? null : value.replace(/^["']|["']$/g, '') });
    }
    out.push(compound);
  }
  return out;
}

export function matches(element: Element, selector: Selector): boolean {
  return selector.some((c) =>
    (c.tag === null || element.tagName === c.tag)
    && c.attrs.every((a) => (a.value === null ? attr(element, a.name) !== null : attr(element, a.name) === a.value))
    && c.classes.every((cls) => (attr(element, 'class') ?? '').split(/[\t\n\f\r ]+/).includes(cls)));
}
