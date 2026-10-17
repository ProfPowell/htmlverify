// A static subset of Accessible Name 1.2 for HTML (spec §7.5). CSS isn't
// evaluated, so generated content and CSS-hidden text are invisible here.

import { childrenOf, isElement, isHtml, isText, type ChildNode, type Element, type Node } from '../parse/tree.ts';
import { nameFromContents, roleData } from '../spec/aria.ts';
import { explicitRole, semanticsOf } from '../spec/html-aria.ts';
import { attr, has, inCategory, inputType } from '../spec/model.ts';
import { indexIds, resolveId, type IdIndex } from './ids.ts';

export type NameSource =
  | 'aria-labelledby' | 'aria-label' | 'label' | 'alt' | 'value' | 'default' | 'legend' | 'caption'
  | 'figcaption' | 'svg title' | 'contents' | 'title' | 'placeholder';

export interface Name {
  name: string;
  source: NameSource | null;
}

const NONE: Name = { name: '', source: null };

const squash = (s: string) => s.replace(/[\t\n\f\r ]+/g, ' ').trim();
const is = (e: Element, ...names: string[]) => isHtml(e) && names.includes(e.tagName);

// Elements whose boundaries separate words when rendered.
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);

/** Accessible names for one parsed input, sharing its ID index, label map, and parent links. */
export class Names {
  private readonly index: IdIndex;
  private readonly parentOf: Map<Node, Node>;
  private readonly context: Element | null;
  private readonly labels = new Map<Element, Element[]>();
  private readonly cache = new Map<Element, Name>();

  /** `context` is a fragment's context element, which counts as the top level's parent. */
  constructor(root: Node, kind: 'document' | 'fragment', parentOf: Map<Node, Node>, context: Element | null = null) {
    this.index = indexIds(root, kind);
    this.parentOf = parentOf;
    this.context = context;
    for (const [element] of this.index.scopeOf) {
      if (!is(element, 'label')) continue;
      const control = this.labeledControl(element);
      if (control) this.labels.set(control, [...(this.labels.get(control) ?? []), element]);
    }
  }

  /** The control a label labels: its for target if labelable, else its first labelable descendant. */
  labeledControl(label: Element): Element | null {
    const forId = attr(label, 'for');
    if (forId !== null) {
      const target = resolveId(this.index, label, forId);
      return target && inCategory(target, 'labelable', []) ? target : null;
    }
    const stack = [...label.childNodes].reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (!isElement(node)) continue;
      if (inCategory(node, 'labelable', [])) return node;
      stack.push(...[...node.childNodes].reverse());
    }
    return null;
  }

  labelsOf(control: Element): readonly Element[] {
    return this.labels.get(control) ?? [];
  }

  /** Ancestors of a node, nearest first; a fragment's context element ends the list. */
  ancestors(node: Node): Element[] {
    const out: Element[] = [];
    let p = this.parentOf.get(node);
    for (; p && isElement(p); p = this.parentOf.get(p)) out.push(p);
    if (p && !this.parentOf.has(p) && p.nodeName === '#document-fragment' && this.context) out.push(this.context);
    return out;
  }

  get ids(): IdIndex {
    return this.index;
  }

  /** Hidden from assistive technology: hidden, aria-hidden="true", or inside either. */
  hidden(element: Element): boolean {
    return [element, ...this.ancestors(element)].some((e) => has(e, 'hidden') || attr(e, 'aria-hidden') === 'true');
  }

  /** The role an element exposes: a valid explicit role, else the implicit one. */
  role(element: Element): string | null {
    const explicit = explicitRole(element);
    if (explicit && roleData(explicit) && !roleData(explicit)!.abstract) return explicit;
    return semanticsOf(element, this.ancestors(element))?.implicit ?? null;
  }

  name(element: Element): Name {
    let result = this.cache.get(element);
    if (!result) {
      result = this.compute(element);
      this.cache.set(element, result);
    }
    return result;
  }

  private compute(element: Element): Name {
    const labelledby = attr(element, 'aria-labelledby');
    if (labelledby !== null) {
      const text = squash(labelledby.split(/\s+/).filter(Boolean).map((id) => {
        const target = resolveId(this.index, element, id);
        return target ? this.text(target, true, new Set([element])) : '';
      }).join(' '));
      if (text) return { name: text, source: 'aria-labelledby' };
    }
    const label = attr(element, 'aria-label')?.trim();
    if (label) return { name: squash(label), source: 'aria-label' };

    const native = this.native(element);
    if (native.name) return native;

    const role = this.role(element);
    if (role && nameFromContents(role)) {
      const text = squash(this.text(element, false, new Set()));
      if (text) return { name: text, source: 'contents' };
    }
    const title = attr(element, 'title')?.trim();
    if (title) return { name: squash(title), source: 'title' };
    // Placeholder is a last resort, and only where it's shown.
    if (is(element, 'textarea') || (is(element, 'input') && ['text', 'search', 'tel', 'url', 'email', 'password', 'number'].includes(inputType(element)))) {
      const placeholder = attr(element, 'placeholder')?.trim();
      if (placeholder) return { name: squash(placeholder), source: 'placeholder' };
    }
    return native.source === 'alt' ? native : NONE;
  }

  /** Names HTML gives elements natively (HTML-AAM). */
  private native(element: Element): Name {
    if (!isHtml(element)) {
      const title = element.childNodes.find((c): c is Element => isElement(c) && c.tagName === 'title');
      return title ? { name: squash(this.text(title, false, new Set())), source: 'svg title' } : NONE;
    }
    const tag = element.tagName;
    if (tag === 'img' || tag === 'area' || (tag === 'input' && inputType(element) === 'image')) {
      const alt = attr(element, 'alt');
      if (alt !== null) return { name: squash(alt), source: 'alt' };
    }
    if (tag === 'input') {
      const type = inputType(element);
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const value = attr(element, 'value');
        if (value !== null && value.trim()) return { name: squash(value), source: 'value' };
        if (type === 'submit') return { name: 'Submit', source: 'default' };
        if (type === 'reset') return { name: 'Reset', source: 'default' };
        return NONE;
      }
    }
    if (inCategory(element, 'labelable', [])) {
      const text = squash(this.labelsOf(element).map((l) => this.text(l, false, new Set([element]))).join(' '));
      if (text) return { name: text, source: 'label' };
    }
    const child = (name: string) => element.childNodes.find((c): c is Element => isElement(c) && is(c, name));
    const sources: Record<string, [string, NameSource]> = { fieldset: ['legend', 'legend'], table: ['caption', 'caption'], figure: ['figcaption', 'figcaption'] };
    const source = sources[tag];
    if (source) {
      const el = child(source[0]);
      const text = el ? squash(this.text(el, false, new Set())) : '';
      if (text) return { name: text, source: source[1] };
    }
    return NONE;
  }

  /**
   * Text of a subtree for naming. Hidden descendants are skipped, unless the
   * walk started at a hidden aria-labelledby target; `skip` holds controls
   * that don't name themselves through their own label.
   */
  private text(node: Node, fromLabelledby: boolean, skip: Set<Element>): string {
    const includeHidden = fromLabelledby && isElement(node) && this.hidden(node);
    const visit = (n: Node, top: boolean): string => {
      if (isText(n)) return n.value;
      if (!isElement(n)) return '';
      if (skip.has(n) && !top) return '';
      if (isHtml(n) && ['script', 'style', 'template', 'noscript', 'head', 'title'].includes(n.tagName) && !top) return '';
      if (!includeHidden && !top && (has(n, 'hidden') || attr(n, 'aria-hidden') === 'true')) return '';
      if (!top) {
        const label = attr(n, 'aria-label')?.trim();
        if (label) return ` ${label} `;
        if (is(n, 'img', 'area')) return ` ${attr(n, 'alt') ?? ''} `;
        if (is(n, 'input')) {
          const type = inputType(n);
          if (type === 'image') return ` ${attr(n, 'alt') ?? ''} `;
          return ` ${attr(n, 'value') ?? ''} `;
        }
        if (is(n, 'textarea', 'select')) return ' ';
        if (!isHtml(n)) return this.native(n).name;
      }
      const inner = childrenOf(n).map((c: ChildNode) => visit(c, false)).join('');
      return isHtml(n) && BLOCKS.has(n.tagName) ? ` ${inner} ` : inner;
    };
    return visit(node, true);
  }
}
