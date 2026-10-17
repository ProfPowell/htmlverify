// Slot fit (spec §9.6): an early, specific error for a child whose roots
// can't go where its slot is. It needs only the templates, so it runs with
// the rest of plan validation; the check of the output has the final word.

import { defaultTreeAdapter as tree } from 'parse5';
import { HTML_ELEMENTS } from '../spec/data.ts';
import { NS } from '../spec/html.ts';
import { mayBeInCategory } from '../spec/model.ts';
import { tags } from '../text.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import type { CompiledTemplate, TNode } from './template.ts';

/** Parents that take only certain children, script-supporting elements aside. */
const CHILDREN: Record<string, readonly string[]> = {
  ul: ['li'], ol: ['li'], menu: ['li'],
  table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot'],
  thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'], colgroup: ['col'],
  dl: ['dt', 'dd', 'div'], select: ['option', 'optgroup', 'hr'], optgroup: ['option'],
  hgroup: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  head: ['meta', 'link', 'title', 'style', 'base', 'noscript'],
};
const SCRIPT_SUPPORTING = ['script', 'template'];

/** Parents whose content is phrasing only; legend and summary also take a heading. */
const PHRASING = new Set([
  'p', 'span', 'em', 'strong', 'small', 's', 'cite', 'q', 'dfn', 'abbr', 'data', 'time', 'code', 'var', 'samp', 'kbd',
  'sub', 'sup', 'i', 'b', 'u', 'mark', 'bdi', 'bdo', 'label', 'button', 'output', 'pre', 'meter', 'progress', 'rt',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'summary',
]);

/** Elements whose content model is their parent's. */
const TRANSPARENT = new Set(['a', 'ins', 'del', 'map', 'object', 'video', 'audio', 'canvas', 'slot', 'noscript']);

/** Elements the parser won't put inside themselves, however deep. */
const NO_NESTING = new Set(['form', 'a', 'button']);

/** List items whose start tag closes an open one, unless a special element other than address, div, or p comes between. */
const CLOSES = { li: ['li'], dd: ['dd', 'dt'], dt: ['dd', 'dt'] } as Record<string, readonly string[]>;
const SPECIAL = new Set([
  'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'col',
  'colgroup', 'dd', 'details', 'dir', 'dl', 'dt', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing',
  'main', 'marquee', 'menu', 'meta', 'nav', 'noembed', 'noframes', 'noscript', 'object', 'ol', 'param', 'plaintext', 'pre', 'script',
  'search', 'section', 'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul', 'wbr', 'xmp',
]);

/** Whether a root element is phrasing content: svg and math are, and so are elements HTML doesn't know, as the checker treats them. */
function phrasing(name: string, vocabulary: Vocabulary): boolean {
  if (name === 'svg' || name === 'math' || SCRIPT_SUPPORTING.includes(name)) return true;
  const entry = vocabulary.get(name);
  if (entry) return entry.element.phrasing;
  return !HTML_ELEMENTS.has(name) || mayBeInCategory(tree.createElement(name, NS.html as never, []), 'phrasing');
}

/** A template's top-level element names, looking through directives. */
export function rootElements(nodes: readonly TNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'element' ? [n.name] : n.kind === 'if' || n.kind === 'each' ? rootElements(n.children) : []));
}

/** Each slot's ancestors inside the template, outermost first: where its children go. */
export function slotAncestors(template: CompiledTemplate): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (nodes: readonly TNode[], chain: string[]) => {
    for (const n of nodes) {
      if (n.kind === 'slot') out.set(n.name, chain);
      else if (n.kind === 'element') walk(n.children, [...chain, n.name]);
      else if (n.kind === 'if' || n.kind === 'each') walk(n.children, chain);
    }
  };
  walk(template.nodes, []);
  return out;
}

/**
 * Why a component's roots can't go inside `chain` (ancestor element names,
 * outermost first), or null when they can as far as an early check can tell.
 */
export function misfit(template: CompiledTemplate, chain: readonly string[], vocabulary: Vocabulary): string | null {
  const roots = [...new Set(rootElements(template.nodes))];
  if (roots.length === 0 || chain.length === 0) return null;
  for (let i = chain.length - 1; i >= 0 && chain[i] !== 'template'; i--) {
    const tag = chain[i]!;
    if (NO_NESTING.has(tag) && roots.includes(tag)) {
      return `it puts <${tag}> inside <${tag}>, and the parser ${tag === 'form' ? 'drops the inner one' : 'closes the outer one first'}.`;
    }
  }
  for (const root of roots) {
    const closes = CLOSES[root];
    if (!closes) continue;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (closes.includes(chain[i]!)) return `it puts <${root}> inside <${chain[i]}>, and the parser closes the open <${chain[i]}> first.`;
      if (SPECIAL.has(chain[i]!)) break;
    }
  }
  const parent = chain.at(-1)!;
  const allowed = CHILDREN[parent];
  if (allowed) {
    const bad = roots.filter((r) => !allowed.includes(r) && !SCRIPT_SUPPORTING.includes(r));
    if (!bad.length) return null;
    const hint = parent === 'table' && bad.includes('tr') ? ' Put the rows in a <tbody>.' : '';
    return `<${parent}> takes ${tags([...allowed, ...SCRIPT_SUPPORTING])}, and its root is ${tags(bad, 'and')}.${hint}`;
  }
  // A transparent parent takes what its own context does.
  const context = chain.findLast((t) => !TRANSPARENT.has(t));
  if (context && PHRASING.has(context)) {
    const heading = context === 'legend' || context === 'summary';
    const bad = roots.filter((r) => !(heading && /^h[1-6]$/.test(r)) && !phrasing(r, vocabulary));
    if (bad.length) return `<${context}> takes phrasing content, and its root is ${tags(bad, 'and')}.`;
  }
  return null;
}
