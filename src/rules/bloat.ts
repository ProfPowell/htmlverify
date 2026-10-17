import { isElement, isHtml, isText, isWhitespaceText, type Element, type Node } from '../parse/tree.ts';
import { kindOf } from '../spec/model.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { spanOf } from './util.ts';

/** Structural metrics (spec §6.8), reported whether or not a threshold is crossed. */
export interface Metrics {
  /** N: HTML and custom elements under body (a fragment's top level), script, style, and template excluded. */
  elements: number;
  generic: number;
  /** generic ÷ N, to two decimals; null when N < the rule's minimum. */
  genericRatio: number | null;
  wrapperChain: number;
  maxClasses: number;
  /** The 95th-percentile class count; null when N < 20. */
  p95Classes: number | null;
  depth: number;
}

export interface BloatResult {
  findings: RawFinding[];
  metrics: Metrics;
}

const EXCLUDED = new Set(['script', 'style', 'template']);

/** Generic elements: div, span, and custom elements, which have no role until a vocabulary gives them one. */
export function isGeneric(e: Element): boolean {
  return (isHtml(e) && (e.tagName === 'div' || e.tagName === 'span')) || kindOf(e) === 'custom';
}

export function checkBloat(ctx: RuleContext): BloatResult {
  const options = ctx.ruleOptions;
  const option = (rule: string, name: string) => options[rule]?.[name] as number;
  const findings: RawFinding[] = [];
  const report = (rule: string, node: Element | null, message: string, evidence: RawFinding['evidence']) =>
    findings.push({ rule, ...(node ? spanOf(node, ctx.text) : { offset: 0, endOffset: 0 }), message, evidence });

  const root: Node = ctx.parsed.kind === 'document'
    ? ctx.parsed.root.childNodes.find((c): c is Element => isElement(c) && isHtml(c) && c.tagName === 'html')?.childNodes
      .find((c): c is Element => isElement(c) && isHtml(c) && c.tagName === 'body') ?? ctx.parsed.root
    : ctx.parsed.root;

  const counted: { element: Element; depth: number; classes: number }[] = [];
  const visit = (node: Node, depth: number) => {
    for (const kid of 'childNodes' in node ? node.childNodes : []) {
      if (!isElement(kid) || (isHtml(kid) && EXCLUDED.has(kid.tagName))) continue;
      if (isHtml(kid) || kindOf(kid) === 'custom') {
        const classes = new Set((kid.attrs.find((a) => a.name === 'class')?.value ?? '').split(/[\t\n\f\r ]+/).filter(Boolean)).size;
        counted.push({ element: kid, depth: depth + 1, classes });
      }
      if (isHtml(kid)) visit(kid, depth + 1);
    }
  };
  visit(root, 0);

  const n = counted.length;
  const generic = counted.filter((c) => isGeneric(c.element)).length;
  const minimum = option('bloat/generic-ratio', 'minElements');
  const ratio = n >= minimum && n > 0 ? Math.round((generic / n) * 100) / 100 : null;
  const top = root.nodeName === 'body' ? (root as Element) : counted[0]?.element ?? null;
  if (ratio !== null && ratio > option('bloat/generic-ratio', 'max')) {
    report('bloat/generic-ratio', top, `${Math.round(ratio * 100)}% of the elements are generic (div, span, custom elements without a role), above ${Math.round(option('bloat/generic-ratio', 'max') * 100)}%; use semantic elements, or data-layout on them.`, { generic, elements: n, ratio });
  }

  // Longest chain of generic only-children with no text beside them.
  let best: { start: Element; length: number } | null = null;
  const onlyGenericChild = (e: Element): Element | null => {
    const kids = e.childNodes.filter((c) => !(isText(c) && isWhitespaceText(c)) && c.nodeName !== '#comment');
    const only = kids.length === 1 && isElement(kids[0]!) ? (kids[0] as Element) : null;
    return only && isGeneric(only) ? only : null;
  };
  const chainLength = new Map<Element, number>();
  for (let i = counted.length - 1; i >= 0; i--) {
    const e = counted[i]!.element;
    if (!isGeneric(e)) continue;
    const child = onlyGenericChild(e);
    const length = 1 + (child ? chainLength.get(child) ?? 1 : 0);
    chainLength.set(e, length);
    if (!best || length >= best.length) best = { start: e, length };
  }
  const wrapperChain = best?.length ?? 0;
  if (best && wrapperChain > option('bloat/wrapper-chain', 'max')) {
    const tags: string[] = [];
    for (let e: Element | null = best.start; e; e = onlyGenericChild(e)) tags.push(e.tagName);
    report('bloat/wrapper-chain', best.start, `${wrapperChain} nested wrappers (${tags.join(' > ')}) hold nothing else; remove the extra ones.`, { length: wrapperChain });
  }

  const sorted = counted.map((c) => c.classes).sort((a, b) => a - b);
  const maxClasses = sorted.at(-1) ?? 0;
  const p95 = n >= 20 ? sorted[Math.ceil(0.95 * n) - 1]! : null;
  const busiest = counted.find((c) => c.classes === maxClasses && maxClasses > 0)?.element ?? null;
  if (maxClasses > option('bloat/class-count', 'max')) {
    report('bloat/class-count', busiest, `<${busiest!.tagName}> has ${maxClasses} classes; more than ${option('bloat/class-count', 'max')} usually means utility classes standing in for a component or data-layout.`, { classes: maxClasses });
  }
  if (p95 !== null && p95 > option('bloat/class-count', 'p95')) {
    report('bloat/class-count', top, `The 95th percentile of class counts is ${p95}, above ${option('bloat/class-count', 'p95')}; most elements carry long class lists.`, { p95 });
  }

  const deepest = counted.reduce<{ element: Element; depth: number } | null>((d, c) => (!d || c.depth > d.depth ? c : d), null);
  const depth = deepest?.depth ?? 0;
  if (deepest && depth > option('bloat/depth', 'max')) {
    report('bloat/depth', deepest.element, `This element is nested ${depth} levels deep, more than ${option('bloat/depth', 'max')}; flatten wrappers.`, { depth });
  }
  if (n > option('bloat/size', 'max')) {
    report('bloat/size', top, `The ${ctx.parsed.kind === 'document' ? 'page' : 'fragment'} has ${n} elements, more than ${option('bloat/size', 'max')}; split it, or remove wrappers.`, { elements: n });
  }

  return { findings, metrics: { elements: n, generic, genericRatio: ratio, wrapperChain, maxClasses, p95Classes: p95, depth } };
}
