import type { DefaultTreeAdapterTypes as T } from 'parse5';
import { NS } from '../spec/html.ts';

export type Node = T.Node;
export type ParentNode = T.ParentNode;
export type ChildNode = T.ChildNode;
export type Element = T.Element;
export type Template = T.Template;
export type TextNode = T.TextNode;
export type Document = T.Document;
export type DocumentFragment = T.DocumentFragment;
export type DocumentType = T.DocumentType;

export function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

export function isText(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

export function isComment(node: Node): boolean {
  return node.nodeName === '#comment';
}

export function isHtml(element: Element): boolean {
  return element.namespaceURI === NS.html;
}

function isTemplate(node: Node): node is Template {
  return isElement(node) && node.tagName === 'template' && isHtml(node);
}

/** Child nodes, reading a template's contents in place of its (empty) children. */
export function childrenOf(node: Node): ChildNode[] {
  if (isTemplate(node)) return node.content.childNodes;
  return 'childNodes' in node ? node.childNodes : [];
}

export function isWhitespaceText(node: Node): boolean {
  return isText(node) && /^[\t\n\f\r ]*$/.test(node.value);
}

/** Visits every node in document order, template contents included, without recursion. */
export function* walk(root: Node): Generator<{ node: Node; parent: Node | null; depth: number }> {
  const stack: { node: Node; parent: Node | null; depth: number }[] = [{ node: root, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    yield entry;
    const kids = childrenOf(entry.node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, parent: entry.node, depth: entry.depth + 1 });
  }
}

/** Source offset where a node starts, or null for nodes the parser created. */
export function startOf(node: Node): number | null {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  if (isElement(node)) return node.sourceCodeLocation?.startTag?.startOffset ?? loc.startOffset;
  return loc.startOffset;
}
