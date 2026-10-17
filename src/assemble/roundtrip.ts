import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, type ChildNode, type Element, type Node } from '../parse/tree.ts';
import { isBooleanAttribute } from '../spec/html.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import { insignificant, preservesWhitespace } from './layout.ts';

export interface CompareOptions {
  vocabulary: Vocabulary | null;
  /** Presence booleans beyond HTML's, such as the vocabulary's. */
  isBoolean?: (element: Element, name: string) => boolean;
  /** A fragment's context element, which decides whether whitespace at its edges can render. */
  context?: Element | null;
}

/** Where two trees first differ: a path like /html/body/main[2]/p[1], and what each side has there. */
export interface Difference {
  path: string;
  expected: string;
  found: string;
}

/**
 * Compares a built tree with the reparse of its serialization (spec §9.8
 * step 6), ignoring only whitespace the serializer may add or re-indent:
 * whitespace-only text where it can't render, a line break's indentation in
 * other whitespace-only text, and trailing whitespace at the end of body or
 * of a fragment, where the final line breaks go. Boolean attributes compare
 * by presence; all else is exact, including attribute order.
 */
export function compareTrees(built: Node, reparsed: Node, options: CompareOptions): Difference | null {
  return compare(built, reparsed, '', false, true, options);
}

function compare(a: Node, b: Node, path: string, preserve: boolean, trimEnd: boolean, options: CompareOptions): Difference | null {
  const at = path || '/';
  if (describe(a) !== describe(b)) return { path: at, expected: describe(a), found: describe(b) };
  if (isElement(a) && isElement(b)) {
    const attrsA = attributes(a, options);
    const attrsB = attributes(b, options);
    if (attrsA !== attrsB) return { path: at, expected: `attributes ${attrsA || '(none)'}`, found: `attributes ${attrsB || '(none)'}` };
  }
  if (isText(a) && isText(b)) {
    if (preserve || !isWhitespaceText(a) || !isWhitespaceText(b)) {
      const trim = (s: string) => (trimEnd ? s.replace(/[\t\n\f\r ]+$/, '') : s);
      if (trim(a.value) !== trim(b.value)) return { path: at, expected: JSON.stringify(a.value), found: JSON.stringify(b.value) };
    }
    return null;
  }
  const keep = preserve || (isElement(a) && preservesWhitespace(a));
  const endsBody = isElement(a) && isHtml(a) && a.tagName === 'body';
  const kidsA = significant(a, keep, trimEnd || endsBody, options);
  const kidsB = significant(b, keep, trimEnd || endsBody, options);
  const count = Math.max(kidsA.length, kidsB.length);
  for (let i = 0; i < count; i++) {
    const x = kidsA[i];
    const y = kidsB[i];
    const step = `${path}/${x ? label(x) : y ? label(y) : '?'}[${i + 1}]`;
    if (!x || !y) return { path: step, expected: x ? describe(x) : 'nothing', found: y ? describe(y) : 'nothing' };
    const d = compare(x, y, step, keep, !keep && (trimEnd || endsBody) && i === count - 1, options);
    if (d) return d;
  }
  return null;
}

/** Children that count: whitespace-only text is dropped where it can't render, and at the end when trimming. */
function significant(node: Node, preserve: boolean, trimEnd: boolean, options: CompareOptions): ChildNode[] {
  const all = childrenOf(node);
  if (preserve) return all;
  const parent = isElement(node) ? node : node.nodeName === '#document-fragment' ? options.context ?? null : null;
  let kids = all.filter((_, i) => !insignificant(all, i, parent, options.vocabulary));
  if (trimEnd && kids.length > 0 && isWhitespaceText(kids.at(-1)!)) kids = kids.slice(0, -1);
  return kids;
}

function attributes(e: Element, options: CompareOptions): string {
  return e.attrs
    .map((a) => {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      const boolean = !a.namespace && ((isHtml(e) && isBooleanAttribute(e.tagName, a.name)) || (options.isBoolean?.(e, a.name) ?? false));
      return boolean ? name : `${name}=${JSON.stringify(a.value)}`;
    })
    .join(' ');
}

function label(node: Node): string {
  return isElement(node) ? node.tagName : node.nodeName;
}

function describe(node: Node): string {
  if (isElement(node)) return `<${node.tagName}>${isHtml(node) ? '' : ` (${node.namespaceURI})`}`;
  if (isText(node)) return isWhitespaceText(node) ? 'whitespace' : 'text';
  if (isComment(node)) return `comment ${JSON.stringify((node as { data: string }).data)}`;
  if (node.nodeName === '#documentType') {
    const d = node as unknown as { name: string; publicId: string; systemId: string };
    return `doctype ${[d.name, d.publicId, d.systemId].filter(Boolean).join(' ')}`;
  }
  if (node.nodeName === '#document') return `document (${(node as { mode: string }).mode})`;
  return node.nodeName;
}
