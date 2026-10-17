import { indexIds, resolveId, type IdIndex } from '../analysis/ids.ts';
import { isElement, isHtml, type Element } from '../parse/tree.ts';
import { attr, has, inCategory, kindOf, tokens } from '../spec/model.ts';
import { closest, tags } from '../text.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { at, describe, locatedElements, readAttribute, spanOf } from './util.ts';

interface Reference {
  attribute: string;
  /** Which elements carry the reference. */
  on: (element: Element) => boolean;
  /** A space-separated list of IDs rather than one. */
  many?: true;
  /** What's wrong with the target, or null. */
  target?: (target: Element, from: Element) => string | null;
}

const is = (element: Element, ...names: string[]) => isHtml(element) && names.includes(element.tagName);
const any = () => true;

const LISTED = ['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea'];
const LABELABLE = ['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'];
const DIALOG_COMMANDS = new Set(['show-modal', 'close', 'request-close']);
const POPOVER_COMMANDS = new Set(['toggle-popover', 'show-popover', 'hide-popover']);

// ARIA ID references; M1b takes these from the ARIA data.
const ARIA_REFERENCES = [
  'aria-activedescendant', 'aria-controls', 'aria-describedby', 'aria-details', 'aria-errormessage', 'aria-flowto',
  'aria-labelledby', 'aria-owns',
];

const REFERENCES: Reference[] = [
  {
    attribute: 'for',
    on: (e) => is(e, 'label'),
    target: (t) => (inCategory(t, 'labelable', []) || kindOf(t) === 'custom' ? null : `which isn’t a labelable control (${tags(LABELABLE)})`),
  },
  { attribute: 'for', on: (e) => is(e, 'output'), many: true },
  { attribute: 'form', on: (e) => is(e, ...LISTED), target: (t) => (is(t, 'form') ? null : 'which isn’t a <form>') },
  { attribute: 'list', on: (e) => is(e, 'input'), target: (t) => (is(t, 'datalist') ? null : 'which isn’t a <datalist>') },
  {
    attribute: 'headers',
    on: (e) => is(e, 'td', 'th'),
    many: true,
    target: (t, from) => (is(t, 'th') && tableOf(t) === tableOf(from) ? null : 'but headers must name <th> cells in the same table'),
  },
  {
    attribute: 'popovertarget',
    on: (e) => is(e, 'button', 'input'),
    target: (t) => (has(t, 'popover') ? null : 'which has no popover attribute'),
  },
  {
    attribute: 'commandfor',
    on: (e) => is(e, 'button'),
    target: (t, from) => {
      const command = attr(from, 'command')?.toLowerCase() ?? '';
      if (DIALOG_COMMANDS.has(command) && !is(t, 'dialog')) return `but command="${command}" needs a <dialog>`;
      if (POPOVER_COMMANDS.has(command) && !has(t, 'popover')) return `but command="${command}" needs an element with popover`;
      return null;
    },
  },
  { attribute: 'itemref', on: any, many: true },
  ...ARIA_REFERENCES.map((attribute): Reference => ({ attribute, on: any, many: true })),
];

function tableOf(element: Element): Element | null {
  let parent = element.parentNode;
  while (parent && isElement(parent)) {
    if (is(parent, 'table')) return parent;
    parent = parent.parentNode;
  }
  return null;
}

/**
 * content/duplicate-id, content/invalid-id, and content/idref. References
 * resolve within the element's scope. In fragments and templates a missing
 * target may live in the host page, so only resolved targets are checked.
 */
export function checkIds(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const index = indexIds(ctx.parsed.root, ctx.parsed.kind);
  const attrSpan = (element: Element, name: string) => {
    const loc = element.sourceCodeLocation?.attrs?.[name];
    if (!loc) return spanOf(element, ctx.text);
    return { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset };
  };

  for (const scope of index.scopes) {
    for (const [id, elements] of scope.ids) {
      const first = elements[0]!;
      if (id === '') {
        for (const e of elements) out.push({ rule: 'content/invalid-id', ...attrSpan(e, 'id'), message: 'id is empty: give it a value, or remove it.' });
        continue;
      }
      if (/[\t\n\f\r ]/.test(id)) {
        for (const e of elements) {
          out.push({
            rule: 'content/invalid-id',
            ...attrSpan(e, 'id'),
            message: `id="${id}" contains whitespace, so nothing can reference it. Use hyphens: id="${id.trim().split(/[\t\n\f\r ]+/).join('-')}".`,
          });
        }
      }
      for (const e of elements.slice(1)) {
        out.push({
          rule: 'content/duplicate-id',
          ...attrSpan(e, 'id'),
          message: `id="${id}" is already used by ${describe(first)} at ${at(ctx, spanOf(first, ctx.text).offset)}. IDs must be unique${scope.kind === 'template' ? ' within a template' : ''}.`,
          evidence: { id },
        });
      }
    }
  }

  for (const element of locatedElements(ctx)) {
    if (kindOf(element) === 'foreign') continue;
    for (const ref of REFERENCES) {
      const value = attr(element, ref.attribute);
      if (value === null || !ref.on(element)) continue;
      const span = attrSpan(element, ref.attribute);
      const scope = index.scopeOf.get(element)!;
      for (const id of ref.many ? tokens(value) : [value]) {
        const target = resolveId(index, element, id);
        if (!target) {
          if (scope.kind !== 'document') continue;
          out.push({ rule: 'content/idref', ...span, message: unresolved(ref.attribute, id, value, index, element), evidence: { attribute: ref.attribute, id } });
          continue;
        }
        const problem = ref.target?.(target, element);
        if (problem) {
          out.push({
            rule: 'content/idref',
            ...span,
            message: `${ref.attribute}="${id}" points to ${describe(target)} at ${at(ctx, spanOf(target, ctx.text).offset)}, ${problem}.`,
            evidence: { attribute: ref.attribute, id },
          });
        }
      }
    }
    // usemap names a map by hash-name reference.
    const usemap = is(element, 'img') ? attr(element, 'usemap') : null;
    if (usemap?.startsWith('#') && usemap.length > 1) {
      const name = usemap.slice(1);
      const scope = index.scopeOf.get(element)!;
      if (scope.kind === 'document' && !mapNamed(ctx, name)) {
        out.push({ rule: 'content/idref', ...attrSpan(element, 'usemap'), message: `usemap="${usemap}" matches no <map name="${name}">.`, evidence: { attribute: 'usemap', id: name } });
      }
    }
  }
  out.push(...orphanProperties(ctx, index, attrSpan));
  return out;
}

/**
 * Microdata: itemprop names a property of an item, so the element must sit
 * inside an itemscope, or be pulled in by an itemref. Fragments and template
 * contents are skipped: their item may be in the page around them.
 */
function orphanProperties(ctx: RuleContext, index: IdIndex, attrSpan: (e: Element, name: string) => { offset: number; endOffset: number }): RawFinding[] {
  if (ctx.parsed.kind !== 'document') return [];
  const referenced = new Set<string>();
  const props: Element[] = [];
  for (const element of locatedElements(ctx)) {
    if (index.scopeOf.get(element)?.kind !== 'document') continue;
    if (has(element, 'itemscope')) for (const id of tokens(attr(element, 'itemref'))) referenced.add(id);
    if (has(element, 'itemprop')) props.push(element);
  }
  const out: RawFinding[] = [];
  for (const element of props) {
    let owned = referenced.has(attr(element, 'id') ?? '');
    for (let a = ctx.signals.parentOf.get(element); a && !owned && isElement(a); a = ctx.signals.parentOf.get(a)) {
      owned = has(a, 'itemscope') || referenced.has(attr(a, 'id') ?? '');
    }
    if (!owned) {
      out.push({ rule: 'content/unknown-attribute', ...attrSpan(element, 'itemprop'), message: 'itemprop names a property of an item, but no element with itemscope contains this one; add itemscope to the item, or reference this element from its itemref.' });
    }
  }
  return out;
}

function unresolved(attribute: string, id: string, value: string, index: IdIndex, from: Element): string {
  const ids = [...(index.scopeOf.get(from)?.ids.keys() ?? [])];
  const near = closest(id, ids);
  const what = value === id ? `${attribute}="${id}"` : `${attribute} names "${id}", which`;
  return `${what} matches no id in this document.${near ? ` Did you mean "${near}"?` : ''}`;
}

function mapNamed(ctx: RuleContext, name: string): boolean {
  for (const element of locatedElements(ctx)) {
    if (is(element, 'map') && (attr(element, 'name') === name || attr(element, 'id') === name)) return true;
  }
  return false;
}
