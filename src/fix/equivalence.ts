import type { Parsed } from '../parse/parse.ts';
import { childrenOf, isElement, isHtml, isWhitespaceText, type Node } from '../parse/tree.ts';
import { isBooleanAttribute } from '../spec/html.ts';
import { inCategory } from '../spec/model.ts';

/** Elements whose whitespace is content: their text compares exactly. */
const PRESERVING = new Set(['pre', 'textarea', 'listing', 'plaintext', 'xmp', 'script', 'style']);

/** Whitespace-only text outside PRESERVING, compared as "some whitespace". */
const WHITESPACE = '#ws';

/**
 * The tree-equivalence contract for fixes (spec §8): node types, namespaces,
 * names, attributes with exact values, text, comments, child order, document
 * mode. Boolean attributes compare by presence. Whitespace-only text outside
 * pre, textarea, listing, plaintext, xmp, script, and style may hold other
 * whitespace but stays present, except that one such node may appear or
 * disappear at the end of body, or of a fragment whose context element isn't
 * phrasing content.
 */
export function treeSignature(parsed: Parsed): string {
  const dropTrailing = parsed.kind === 'fragment' && parsed.context !== null && !inCategory(parsed.context, 'phrasing', []);
  return JSON.stringify(signature(parsed.root, false, dropTrailing));
}

function signature(node: Node, preserve: boolean, dropTrailing: boolean): unknown {
  if (isElement(node)) {
    const attrs = node.attrs
      .map((a) => [a.namespace ?? '', a.prefix ?? '', a.name, isHtml(node) && isBooleanAttribute(node.tagName, a.name) ? true : a.value])
      .sort((a, b) => String(a.slice(0, 3)).localeCompare(String(b.slice(0, 3))));
    const keep = preserve || PRESERVING.has(node.tagName);
    return [node.namespaceURI, node.tagName, attrs, children(node, keep, isHtml(node) && node.tagName === 'body')];
  }
  switch (node.nodeName) {
    case '#text':
      return !preserve && isWhitespaceText(node) ? WHITESPACE : ['#text', 'value' in node ? node.value : ''];
    case '#comment':
      return ['#comment', 'data' in node ? node.data : ''];
    case '#documentType':
      return 'name' in node ? ['#doctype', node.name, node.publicId ?? '', node.systemId ?? ''] : ['#doctype'];
    case '#document':
      return ['#document', 'mode' in node ? node.mode : '', children(node, preserve, false)];
    default:
      return [node.nodeName, children(node, preserve, dropTrailing)];
  }
}

function children(node: Node, preserve: boolean, dropTrailing: boolean): unknown[] {
  const out = childrenOf(node).map((c) => signature(c, preserve, false));
  if (dropTrailing && out.at(-1) === WHITESPACE) out.pop();
  return out;
}
