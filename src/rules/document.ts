import { indexIds } from '../analysis/ids.ts';
import { isHtml, walk, type Element } from '../parse/tree.ts';
import { attr, has } from '../spec/model.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { at, spanOf } from './util.ts';

/** content/document: one visible main, and one character encoding declaration, per document. */
export function checkDocument(ctx: RuleContext): RawFinding[] {
  if (ctx.parsed.kind !== 'document') return [];
  const top = indexIds(ctx.parsed.root, 'document');
  const inDocument = (e: Element) => top.scopeOf.get(e)?.kind === 'document';
  const mains: Element[] = [];
  const encodings: Element[] = [];
  for (const { node } of walk(ctx.parsed.root)) {
    if (!('tagName' in node) || !isHtml(node) || !inDocument(node)) continue;
    if (node.tagName === 'main' && !has(node, 'hidden')) mains.push(node);
    if (node.tagName === 'meta' && (has(node, 'charset') || attr(node, 'http-equiv')?.toLowerCase() === 'content-type')) encodings.push(node);
  }
  const out: RawFinding[] = [];
  const first = (list: Element[]) => at(ctx, spanOf(list[0]!, ctx.text).offset);
  for (const extra of mains.slice(1)) {
    out.push({ rule: 'content/document', ...spanOf(extra, ctx.text), message: `A document can have only one visible <main>; the first is at ${first(mains)}. Hide the others with hidden, or use another element.` });
  }
  for (const extra of encodings.slice(1)) {
    out.push({ rule: 'content/document', ...spanOf(extra, ctx.text), message: `A document can have only one character encoding declaration; the first is at ${first(encodings)}. Keep one <meta charset="utf-8">.` });
  }
  return out;
}
