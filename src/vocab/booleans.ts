import { isElement, type Element } from '../parse/tree.ts';
import { matches, parseSelector, type Selector } from './select.ts';
import type { Vocabulary } from './vocabulary.ts';

/**
 * The vocabulary's presence booleans: an element's own (accordion-wc[single])
 * and those a component ancestor declares for it (drop-down's
 * button[data-trigger]). They compare by presence, like HTML's (spec §8).
 */
export function vocabularyBooleans(vocabulary: Vocabulary): (element: Element, name: string) => boolean {
  const selectors = new Map<string, Selector | null>();
  const selector = (on: string) => {
    if (!selectors.has(on)) selectors.set(on, parseSelector(on));
    return selectors.get(on)!;
  };
  return (element, name) => {
    if (vocabulary.get(element.tagName)?.element.attributes[name]?.type === 'boolean') return true;
    if (!vocabulary.childBooleanNames.has(name)) return false;
    for (let a = element.parentNode; a && isElement(a); a = a.parentNode) {
      for (const c of vocabulary.get(a.tagName)?.element.childAttributes ?? []) {
        const s = c.name === name && c.type === 'boolean' ? selector(c.on) : null;
        if (s && matches(element, s)) return true;
      }
    }
    return false;
  };
}
