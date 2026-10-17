import { isElement, isHtml, walk, type Element, type Node } from '../parse/tree.ts';
import type { RuleContext } from './types.ts';

export function at(ctx: RuleContext, offset: number): string {
  const p = ctx.lines.position(offset);
  return `${p.line}:${p.column}`;
}

export function startTagSpan(element: Element): { offset: number; endOffset: number } {
  const tag = element.sourceCodeLocation!.startTag!;
  return { offset: tag.startOffset, endOffset: tag.endOffset };
}

export function describe(node: Node): string {
  if (isElement(node)) return `<${node.tagName}>`;
  if ('value' in node) {
    const text = node.value.trim().replace(/\s+/g, ' ');
    return `text "${text.length > 24 ? `${text.slice(0, 24)}…` : text}"`;
  }
  return node.nodeName;
}

/** Elements that have a start tag in the source, in document order. */
export function* locatedElements(ctx: RuleContext): Generator<Element> {
  for (const { node } of walk(ctx.parsed.root)) {
    if (isElement(node) && node.sourceCodeLocation?.startTag) yield node;
  }
}

/** Reads a tag or attribute name starting at `offset`. */
export function nameAt(text: string, offset: number): string {
  let end = offset;
  while (end < text.length && !/[\t\n\f\r />=]/.test(text[end]!)) end++;
  return text.slice(offset, end);
}

export interface RawAttribute {
  name: string;
  /** `bare` has no "=", `none` has "=" and an unquoted value. */
  quote: 'bare' | 'none' | '"' | "'";
  /** Offsets of the value as written, quotes excluded. */
  valueOffset: number;
  valueEndOffset: number;
  /** End of the name, where a bare attribute's value would go. */
  nameEndOffset: number;
  /** End of the whole attribute. */
  endOffset: number;
}

const SPACE = /[\t\n\f\r ]/;

/**
 * Scans one attribute from its first character, following the tokenizer's
 * attribute states. parse5's attribute spans drop the value when the next
 * attribute follows without whitespace (`href="/x"class="y"`), so the extent
 * comes from the source, not the parser.
 */
export function readAttribute(text: string, offset: number): RawAttribute {
  let i = offset;
  if (text[i] === '=') i++;
  while (i < text.length && !SPACE.test(text[i]!) && text[i] !== '/' && text[i] !== '>' && text[i] !== '=') i++;
  const name = text.slice(offset, i);
  const bare = { name, quote: 'bare', valueOffset: i, valueEndOffset: i, nameEndOffset: i, endOffset: i } as const;
  let j = i;
  while (j < text.length && SPACE.test(text[j]!)) j++;
  if (text[j] !== '=') return bare;
  j++;
  while (j < text.length && SPACE.test(text[j]!)) j++;
  const quote = text[j];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, j + 1);
    const end = close === -1 ? text.length : close;
    return { name, quote, valueOffset: j + 1, valueEndOffset: end, nameEndOffset: i, endOffset: close === -1 ? end : end + 1 };
  }
  let k = j;
  while (k < text.length && !SPACE.test(text[k]!) && text[k] !== '>') k++;
  return { name, quote: 'none', valueOffset: j, valueEndOffset: k, nameEndOffset: i, endOffset: k };
}

/** The innermost located element whose source span contains `offset`. */
export function openElementAt(ctx: RuleContext, offset: number): Element | null {
  let best: Element | null = null;
  for (const element of locatedElements(ctx)) {
    const loc = element.sourceCodeLocation!;
    const start = loc.startTag!.startOffset;
    const end = loc.endTag?.endOffset ?? loc.endOffset;
    if (start < offset && offset < end) best = element;
  }
  return best;
}

export function htmlName(element: Element | null): string | null {
  return element && isHtml(element) ? element.tagName : null;
}
