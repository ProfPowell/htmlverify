import { isComment, isElement, isHtml, isWhitespaceText, type ChildNode, type Element } from '../parse/tree.ts';
import { HTML_ELEMENTS } from '../spec/data.ts';
import { NS } from '../spec/html.ts';
import { mayBeInCategory } from '../spec/model.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';

// Where whitespace can render (spec §9.9). The serializer, the round-trip
// check, and the template compiler share these, so the whitespace one adds
// is exactly the whitespace the others ignore.

/** Elements whose content is written exactly: their whitespace is content. */
const PRESERVE = {
  [NS.html]: new Set(['pre', 'textarea', 'listing', 'plaintext', 'xmp', 'script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'title']),
  [NS.svg]: new Set(['text', 'tspan', 'textPath', 'title', 'desc', 'style', 'script']),
  [NS.mathml]: new Set(['mi', 'mn', 'mo', 'ms', 'mtext', 'annotation']),
};

/** Phrasing elements that draw nothing, so whitespace beside them can't show. */
const SILENT = new Set(['script', 'template', 'link', 'meta']);

export function preservesWhitespace(element: Element): boolean {
  return PRESERVE[element.namespaceURI as keyof typeof PRESERVE]?.has(element.tagName) ?? false;
}

/**
 * Whether whitespace beside an element can render. That holds for HTML
 * phrasing content, custom elements the vocabulary calls phrasing (or any it
 * doesn't know), unknown elements, and the svg and math roots. It never holds
 * inside foreign content, where whitespace between elements isn't drawn.
 */
export function inlineLevel(element: Element, vocabulary: Vocabulary | null): boolean {
  if (!isHtml(element)) {
    const parent = element.parentNode;
    return !(parent && isElement(parent) && !isHtml(parent));
  }
  if (SILENT.has(element.tagName)) return false;
  const entry = vocabulary?.get(element.tagName);
  if (entry) return entry.element.phrasing;
  return HTML_ELEMENTS.has(element.tagName) ? mayBeInCategory(element, 'phrasing') : true;
}

/** A child that whitespace beside it can't affect: a comment, or an element that isn't inline-level. */
export function blockItem(node: ChildNode, vocabulary: Vocabulary | null): boolean {
  return isComment(node) || (isElement(node) && !inlineLevel(node, vocabulary));
}

/**
 * Whether the whitespace-only text among an element's children is
 * insignificant: the element doesn't preserve whitespace and every other
 * child is a block item.
 */
export function whitespaceIgnorable(parent: Element | null, children: readonly ChildNode[], vocabulary: Vocabulary | null): boolean {
  if (parent && preservesWhitespace(parent)) return false;
  return children.every((c) => isWhitespaceText(c) || blockItem(c, vocabulary));
}
