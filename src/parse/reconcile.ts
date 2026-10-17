import { endTagMayBeOmitted, VOID_ELEMENTS, type Following } from '../spec/html.ts';
import type { Parsed, TagToken } from './parse.ts';
import {
  childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, startOf, walk,
  type ChildNode, type Element, type Node,
} from './tree.ts';

export interface Unclosed {
  element: Element;
  /** True when the optional-tag rules allow the omission. */
  omissionAllowed: boolean;
  /** Offset where the parser closed the element. */
  closedAt: number;
  /** The token that closed it, or null at the end of the input. */
  closedBy: TagToken | null;
}

export interface Moved {
  node: ChildNode;
  /** Source range of the moved content. */
  offset: number;
  endOffset: number;
  /** The later sibling this node was placed before, for content moved out of a table. */
  before: ChildNode | null;
  /** The parent this node was moved into, when it appears outside that parent in the source. */
  into: Element | null;
}

/** Where the tree differs from what the source tokens say, and why. */
export interface Signals {
  /** Elements created by the parser, with no start tag in the source. */
  implied: Element[];
  /** Non-void elements with a start tag and no end tag. */
  unclosed: Unclosed[];
  /** Start tags that produced no element. */
  droppedStart: TagToken[];
  /** End tags that closed nothing. */
  strayEnd: TagToken[];
  /** Elements cloned from one start tag while repairing misnested formatting. */
  clones: Element[][];
  moved: Moved[];
  startToken: Map<Element, TagToken>;
  parentOf: Map<Node, Node>;
}

export function reconcile(parsed: Parsed, text: string): Signals {
  const startByOffset = new Map<number, TagToken>();
  const tokenAt = new Map<number, TagToken>();
  for (const token of parsed.tokens) {
    if (token.kind === 'start') startByOffset.set(token.offset, token);
    tokenAt.set(token.offset, token);
  }

  const owners = new Map<number, Element[]>();
  const endOwned = new Set<number>();
  const implied: Element[] = [];
  const candidates: Element[] = [];
  const startToken = new Map<Element, TagToken>();
  const parentOf = new Map<Node, Node>();
  const nextOf = new Map<Node, ChildNode | null>();

  for (const { node, parent } of walk(parsed.root)) {
    if (parent) parentOf.set(node, parent);
    const kids = childrenOf(node);
    for (let i = 0; i < kids.length; i++) nextOf.set(kids[i]!, kids[i + 1] ?? null);
    if (!isElement(node)) continue;
    const loc = node.sourceCodeLocation;
    if (!loc) {
      implied.push(node);
      continue;
    }
    const start = startOf(node)!;
    const group = owners.get(start);
    if (group) group.push(node);
    else owners.set(start, [node]);
    const token = startByOffset.get(start);
    if (token) startToken.set(node, token);
    if (loc.endTag) endOwned.add(loc.endTag.startOffset);
    else if (!(isHtml(node) ? VOID_ELEMENTS.has(node.tagName) : token?.selfClosing)) candidates.push(node);
  }

  const contextName = parsed.context && isHtml(parsed.context) ? parsed.context.tagName : null;
  const unclosed = candidates.map((element): Unclosed => {
    const loc = element.sourceCodeLocation!;
    // An element popped at end of input inside raw text keeps an end offset
    // before its own start tag ends; it actually runs to the end.
    const closedAt = loc.endOffset < loc.startTag!.endOffset ? text.length : loc.endOffset;
    return {
      element,
      omissionAllowed: isHtml(element) && endTagMayBeOmitted(element.tagName, following(element, parentOf, nextOf, contextName)),
      closedAt,
      closedBy: tokenAt.get(closedAt) ?? null,
    };
  });

  return {
    implied,
    unclosed,
    droppedStart: parsed.tokens.filter((t) => t.kind === 'start' && !owners.has(t.offset)),
    strayEnd: parsed.tokens.filter((t) => t.kind === 'end' && !endOwned.has(t.offset)),
    clones: [...owners.values()].filter((group) => group.length > 1),
    moved: findMoved(parsed.root, text),
    startToken,
    parentOf,
  };
}

function following(element: Element, parentOf: Map<Node, Node>, nextOf: Map<Node, ChildNode | null>, contextName: string | null): Following {
  const parent = parentOf.get(element) ?? null;
  const next = nextOf.get(element) ?? null;
  let parentName: string | null = null;
  if (parent && isElement(parent)) parentName = isHtml(parent) ? parent.tagName : null;
  else if (parent?.nodeName === '#document-fragment') parentName = contextName;
  return {
    nextElement: next && isElement(next) && isHtml(next) ? next.tagName : null,
    nextIsComment: next !== null && isComment(next),
    nextIsCommentOrSpace: next !== null && (isComment(next) || isWhitespaceText(next)),
    last: next === null,
    parent: parentName,
  };
}

/**
 * Finds nodes the parser moved. A node placed before a sibling that appears
 * earlier in the source was foster-parented out of a table; a node that starts
 * outside its parent's source span was moved into it (content after `</body>`,
 * or a `meta` after `</head>`).
 */
function findMoved(root: Node, text: string): Moved[] {
  const moved: Moved[] = [];
  for (const { node } of walk(root)) {
    // Foster-parented text is appended to a text node before the table, whose
    // span then runs into the table.
    const all = childrenOf(node);
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i]!;
      const b = all[i + 1]!;
      const next = startOf(b);
      if (!isText(a) || !a.sourceCodeLocation || next === null || a.sourceCodeLocation.endOffset <= next) continue;
      const end = a.sourceCodeLocation.endOffset;
      let from = isElement(b) ? (b.sourceCodeLocation?.startTag?.endOffset ?? next) : next;
      for (const { node: d } of walk(b)) {
        const e = d.sourceCodeLocation?.endOffset;
        if (e !== undefined && e <= end && e > from) from = e;
      }
      let s = from;
      let t = end;
      while (s < t && /[\t\n\f\r ]/.test(text[s]!)) s++;
      while (t > s && /[\t\n\f\r ]/.test(text[t - 1]!)) t--;
      moved.push({ node: a, before: b, into: null, offset: s, endOffset: t });
    }

    const kids = all.filter(located);
    let minLater = Number.POSITIVE_INFINITY;
    let minNode: ChildNode | null = null;
    const placedBefore = new Map<ChildNode, ChildNode>();
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!;
      const start = startOf(kid)!;
      if (start > minLater && minNode) placedBefore.set(kid, minNode);
      if (start < minLater) {
        minLater = start;
        minNode = kid;
      }
    }
    const span = isElement(node) ? spanOf(node) : null;
    for (const kid of kids) {
      if (moved.some((m) => m.node === kid)) continue;
      const before = placedBefore.get(kid);
      const range = { offset: startOf(kid)!, endOffset: isElement(kid) ? kid.sourceCodeLocation!.startTag!.endOffset : kid.sourceCodeLocation!.endOffset };
      if (before) moved.push({ node: kid, before, into: null, ...range });
      else if (span && isElement(node) && (range.offset < span.start || range.offset >= span.end)) {
        moved.push({ node: kid, before: null, into: node, ...range });
      }
    }
  }
  return moved;
}

function located(node: ChildNode): boolean {
  if (startOf(node) === null) return false;
  return isElement(node) || (isText(node) && !isWhitespaceText(node));
}

/** Source span of an element that has both tags; null when either was implied or omitted. */
function spanOf(element: Element): { start: number; end: number } | null {
  const loc = element.sourceCodeLocation;
  if (!loc?.startTag || !loc.endTag) return null;
  return { start: loc.startTag.startOffset, end: loc.endTag.endOffset };
}
