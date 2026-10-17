import { parseHtml } from '../src/parse/parse.ts';
import { childrenOf, isElement, isHtml, type Node } from '../src/parse/tree.ts';
import { isBooleanAttribute } from '../src/spec/html.ts';
import type { Edit } from '../src/rules/types.ts';

/** Applies non-overlapping edits; throws if any two overlap. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.offset - b.offset || a.endOffset - b.endOffset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (next.offset < prev.endOffset || (next.offset === prev.offset && next.offset === next.endOffset && prev.offset === prev.endOffset)) {
      throw new Error(`overlapping edits at ${prev.offset}-${prev.endOffset} and ${next.offset}-${next.endOffset}`);
    }
  }
  let out = text;
  for (const edit of sorted.reverse()) out = out.slice(0, edit.offset) + edit.text + out.slice(edit.endOffset);
  return out;
}

/**
 * The tree-equivalence contract for fixes (spec §8): node types, namespaces,
 * names, attributes with exact values, text, comments, child order, document
 * mode. Boolean attributes compare by presence.
 */
export function treeSignature(text: string, context: string | null): string {
  return JSON.stringify(signature(parseHtml(text, context).root));
}

function signature(node: Node): unknown {
  if (isElement(node)) {
    const attrs = node.attrs
      .map((a) => [a.namespace ?? '', a.prefix ?? '', a.name, isHtml(node) && isBooleanAttribute(node.tagName, a.name) ? true : a.value])
      .sort((a, b) => String(a.slice(0, 3)).localeCompare(String(b.slice(0, 3))));
    return [node.namespaceURI, node.tagName, attrs, childrenOf(node).map(signature)];
  }
  switch (node.nodeName) {
    case '#text':
    case '#comment':
      return [node.nodeName, 'value' in node ? node.value : 'data' in node ? node.data : ''];
    case '#documentType':
      return 'name' in node ? ['#doctype', node.name, node.publicId ?? '', node.systemId ?? ''] : ['#doctype'];
    case '#document':
      return ['#document', 'mode' in node ? node.mode : '', childrenOf(node).map(signature)];
    default:
      return [node.nodeName, childrenOf(node).map(signature)];
  }
}
