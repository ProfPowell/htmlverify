// Instantiation (spec §9.6, §9.8 step 4): plan instances and their compiled
// templates become one in-memory tree. IDs are allocated from key paths,
// heading levels from nesting, references are resolved and pruned, and every
// node records its origin.

import { defaultTreeAdapter as tree } from 'parse5';
import { isElement, isHtml, walk, type ChildNode, type Document, type DocumentFragment, type Element, type Node, type ParentNode, type Template } from '../parse/tree.ts';
import type { CheckOptions } from '../report/report.ts';
import type { Coverage } from './coverage.ts';
import { NS } from '../spec/html.ts';
import { isObject, type Value, type ValueOptions } from './params.ts';
import type { PlanHtml, PlanInstance, PlanNode } from './plan.ts';
import type { Component } from './registry.ts';
import { parseRestricted } from './restricted.ts';
import type { IdToken, Path, TAttr, TNode } from './template.ts';

export interface NodeOrigin {
  component: string;
  template: string | null;
  instance: string;
  plan: string;
  /** Template markup, a parameter's value, or an HTML node. */
  source: 'template' | 'data' | 'html';
}

export interface AssemblyProblem {
  rule: string;
  pointer: string;
  message: string;
}

export interface Built {
  root: Document | DocumentFragment;
  origins: WeakMap<Node, NodeOrigin>;
  /** Attributes whose values came from data, per element. */
  bound: WeakMap<Element, Set<string>>;
  /** Elements holding text that came from data. */
  dataText: WeakSet<Element>;
  problems: AssemblyProblem[];
  /** HTML nodes, each a registry gap (spec §9.6). */
  gaps: { instance: string; plan: string }[];
}

export interface InstantiateOptions {
  values: ValueOptions;
  /** Records the branches and loops a component check's fixtures exercise. */
  coverage?: Coverage | null;
  check: CheckOptions;
}

interface Frame {
  component: Component;
  node: PlanInstance;
  path: string[];
  data: Record<string, Value>;
  received: number;
  current: number;
  /** Symbols whose element rendered. */
  rendered: Set<string>;
  references: { element: Element; attr: Attr; tokens: IdToken[]; single: boolean }[];
  fragments: { element: Element; attr: Attr; symbol: string }[];
  elements: number;
}

type Scope = ReadonlyMap<string, Value>;
type Attr = Element['attrs'][number];

/** Fills in a placeholder attribute, or removes it, keeping template order. */
function settle(element: Element, attr: Attr, value: string | null): void {
  if (value === null) element.attrs.splice(element.attrs.indexOf(attr), 1);
  else attr.value = value;
}

/** Lists of IDs to drop unrendered symbols from; other reference attributes need theirs. */
const LIST_REFERENCES = new Set(['aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-owns', 'aria-details', 'aria-flowto', 'aria-errormessage', 'headers', 'itemref', 'for']);

export class Builder {
  readonly #components: ReadonlyMap<PlanInstance, Component>;
  readonly #data: ReadonlyMap<PlanInstance, Record<string, Value>>;
  readonly #options: InstantiateOptions;
  readonly #built: Built;
  /** Each instance's own ID (its @ symbol), by key path, for ref parameters. */
  readonly #instances = new Map<string, { id: string | null; pointer: string }>();
  readonly #refs: { element: Element; attr: Attr; ref: string; href: boolean; pointer: string }[] = [];

  constructor(components: ReadonlyMap<PlanInstance, Component>, data: ReadonlyMap<PlanInstance, Record<string, Value>>, options: InstantiateOptions) {
    this.#components = components;
    this.#data = data;
    this.#options = options;
    this.#built = { root: tree.createDocumentFragment(), origins: new WeakMap(), bound: new WeakMap(), dataText: new WeakSet(), problems: [], gaps: [] };
  }

  async page(root: PlanInstance): Promise<Built> {
    const doc = tree.createDocument();
    tree.setDocumentMode(doc, 'no-quirks' as Parameters<typeof tree.setDocumentMode>[1]);
    this.#built.root = doc;
    await this.#instance(root, doc, null, [], 0);
    this.#finish();
    return this.#built;
  }

  async fragment(context: string, rank: number, children: PlanNode[]): Promise<Built> {
    const root = tree.createDocumentFragment();
    this.#built.root = root;
    const contextElement = tree.createElement(context, NS.html as never, []);
    await this.#children(children, root, contextElement, [], rank);
    this.#finish();
    return this.#built;
  }

  /** Advice for a heading that would go past h6. */
  #shallower(): string {
    return this.#built.root.nodeName === '#document' ? 'nest it less deeply' : 'nest it less deeply, or give the fragment a lower rank';
  }

  #problem(rule: string, pointer: string, message: string): void {
    this.#built.problems.push({ rule, pointer, message });
  }

  async #instance(node: PlanInstance, parent: ParentNode, context: Element | null, path: string[], rank: number): Promise<void> {
    const component = this.#components.get(node)!;
    const frame: Frame = {
      component, node, path, data: this.#data.get(node)!, received: rank, current: rank,
      rendered: new Set(), references: [], fragments: [], elements: 0,
    };
    await this.#nodes(component.template.nodes, parent, context, frame, new Map());
    // References within the instance, now that its rendered symbols are known.
    for (const r of frame.references) {
      const ids: string[] = [];
      for (const t of r.tokens) {
        if ('literal' in t) ids.push(t.literal);
        else if (frame.rendered.has(t.symbol)) ids.push(this.#symbolId(frame, t.symbol));
        else if (r.single || !LIST_REFERENCES.has(r.attr.name)) {
          this.#problem('assembly/ref', node.pointer, `${r.attr.name}="@${t.symbol}" in ${component.id} refers to an element that didn’t render; render it, or make the reference conditional too.`);
        }
      }
      settle(r.element, r.attr, ids.length ? ids.join(' ') : null);
    }
    for (const f of frame.fragments) {
      if (frame.rendered.has(f.symbol)) settle(f.element, f.attr, `#${this.#symbolId(frame, f.symbol)}`);
      else {
        settle(f.element, f.attr, null);
        this.#problem('assembly/ref', node.pointer, `href="#@${f.symbol}" in ${component.id} links to an element that didn’t render.`);
      }
    }
    // The budget bounds the component's own markup, repetitions included; markup values and slot children don't count.
    const budget = component.contract.budget;
    if (budget && frame.elements > budget.elements) {
      this.#problem('assembly/budget', node.pointer, `${component.id} rendered ${frame.elements} elements, more than its budget of ${budget.elements}; that usually means too much data, or a component that should be split.`);
    }
    this.#instances.set(path.join('/'), { id: frame.rendered.has('') && path.length ? this.#symbolId(frame, '') : null, pointer: node.pointer });
  }

  /** An instance's ID for a symbol: contact/email's @input is contact-email-input, its @ is contact-email. */
  #symbolId(frame: Frame, symbol: string): string {
    const prefix = frame.path.join('-');
    return prefix ? (symbol ? `${prefix}-${symbol}` : prefix) : symbol;
  }

  #origin(frame: Frame, loc: { line: number; column: number } | null, source: NodeOrigin['source'] = 'template', pointer = frame.node.pointer): NodeOrigin {
    return {
      component: `${frame.component.id}@${frame.component.contract.version}`,
      template: loc ? `template.html:${loc.line}:${loc.column}` : null,
      instance: frame.path.join('/'),
      plan: pointer,
      source,
    };
  }

  #lookup(path: Path, frame: Frame, scope: Scope): Value | undefined {
    const base = scope.has(path.root) ? scope.get(path.root) : frame.data[path.root];
    if (path.field === null) return base;
    return isObject(base) ? (base as Record<string, Value>)[path.field] : undefined;
  }

  async #nodes(nodes: readonly TNode[], parent: ParentNode, context: Element | null, frame: Frame, scope: Scope): Promise<void> {
    for (const n of nodes) {
      switch (n.kind) {
        case 'doctype':
          tree.setDocumentType(parent as Document, n.name, n.publicId, n.systemId);
          break;
        case 'text':
          tree.insertText(parent, n.value);
          break;
        case 'value': {
          const v = this.#lookup(n.path, frame, scope);
          if (v === undefined) break;
          if (n.type === 'inline' || n.type === 'prose') await this.#markup(String(v), n.type, parent, context, frame, `${frame.node.pointer}/data/${n.path.root}`);
          else {
            tree.insertText(parent, String(v));
            if (isElement(parent as Node)) this.#built.dataText.add(parent as Element);
          }
          break;
        }
        case 'if': {
          const v = this.#lookup(n.path, frame, scope);
          const on = typeof v === 'boolean' ? v : v !== undefined;
          this.#options.coverage?.branch(frame.component.id, n.loc, on !== n.negate);
          if (on !== n.negate) await this.#nodes(n.children, parent, context, frame, scope);
          break;
        }
        case 'each': {
          const v = this.#lookup(n.path, frame, scope);
          const items = Array.isArray(v) ? v : [];
          this.#options.coverage?.loop(frame.component.id, n.loc, items.length);
          for (const item of items) await this.#nodes(n.children, parent, context, frame, new Map(scope).set(n.as, item));
          break;
        }
        case 'slot':
          await this.#children(frame.node.slots[n.name] ?? [], parent, context, frame.path, frame.current);
          break;
        case 'element':
          await this.#element(n, parent, frame, scope);
          break;
      }
    }
  }

  async #element(n: Extract<TNode, { kind: 'element' }>, parent: ParentNode, frame: Frame, scope: Scope): Promise<void> {
    let name = n.name;
    if (n.rank !== null) {
      const level = frame.received + n.rank;
      if (level > 6) this.#problem('assembly/heading-depth', frame.node.pointer, `${frame.component.id}’s heading would be level ${level}, past <h6>; ${this.#shallower()}.`);
      name = `h${Math.min(level, 6)}`;
      frame.current = Math.min(level, 6);
    } else if (n.namespace === NS.html && /^h[1-6]$/.test(name)) {
      frame.current = Number(name[1]);
    }
    const element = tree.createElement(name, n.namespace as never, []);
    this.#built.origins.set(element, this.#origin(frame, n.loc));
    for (const a of n.attrs) this.#attribute(a, element, frame, scope);
    frame.elements++;
    tree.appendChild(parent, element);
    let inner: ParentNode = element;
    if (n.namespace === NS.html && name === 'template') {
      const content = tree.createDocumentFragment();
      tree.setTemplateContent(element as Template, content);
      inner = content;
    }
    await this.#nodes(n.children, inner, element, frame, scope);
  }

  #attribute(a: TAttr, element: Element, frame: Frame, scope: Scope): void {
    const bind = () => {
      const set = this.#built.bound.get(element) ?? new Set<string>();
      set.add(a.name);
      this.#built.bound.set(element, set);
    };
    switch (a.kind) {
      case 'static':
        element.attrs.push({ name: a.name, value: a.value, ...(a.namespace ? { namespace: a.namespace } : {}), ...(a.prefix ? { prefix: a.prefix } : {}) });
        return;
      case 'value': {
        const v = this.#lookup(a.path, frame, scope);
        if (v === undefined || v === false) return;
        bind();
        if (a.type === 'boolean') element.attrs.push({ name: a.name, value: '' });
        else if (a.type === 'ref') {
          const attr: Attr = { name: a.name, value: '' };
          element.attrs.push(attr);
          this.#refs.push({ element, attr, ref: (v as { ref: string }).ref, href: a.name === 'href', pointer: `${frame.node.pointer}/data/${a.path.root}` });
        } else element.attrs.push({ name: a.name, value: String(v) });
        return;
      }
      case 'mixed': {
        bind();
        let value = a.parts.map((p) => (typeof p === 'string' ? p : String(this.#lookup(p, frame, scope) ?? ''))).join('');
        if (a.name === 'class') value = value.split(/[\t\n\f\r ]+/).filter(Boolean).join(' ');
        if (value !== '') element.attrs.push({ name: a.name, value });
        return;
      }
      case 'ids':
        if (a.name === 'id') {
          const symbol = (a.tokens[0] as { symbol: string }).symbol;
          if (!symbol && frame.path.length === 0) {
            this.#problem('assembly/ref', frame.node.pointer, `id="@" in ${frame.component.id} needs an instance ID, but the page root has no key; name the symbol, such as id="@main".`);
            return;
          }
          element.attrs.push({ name: 'id', value: this.#symbolId(frame, symbol) });
          frame.rendered.add(symbol);
        } else {
          const attr: Attr = { name: a.name, value: '' };
          element.attrs.push(attr);
          frame.references.push({ element, attr, tokens: a.tokens, single: a.single });
        }
        return;
      case 'fragment': {
        const attr: Attr = { name: a.name, value: '' };
        element.attrs.push(attr);
        frame.fragments.push({ element, attr, symbol: a.symbol });
        return;
      }
    }
  }

  /** A slot's children, or a fragment's: components and HTML nodes, checked against where they go. */
  async #children(children: readonly PlanNode[], parent: ParentNode, context: Element | null, path: string[], rank: number): Promise<void> {
    const where = isElement(parent as Node) ? (parent as Element) : context;
    for (const child of children) {
      if (child.kind === 'html') {
        await this.#html(child, parent, where, path);
        continue;
      }
      await this.#instance(child, parent, where, [...path, child.key!], rank);
    }
  }

  async #html(node: PlanHtml, parent: ParentNode, where: Element | null, path: string[]): Promise<void> {
    const context = where?.tagName ?? 'body';
    const parsed = await parseRestricted(node.html, 'html', context, `${node.pointer}/html`, { values: this.#options.values, check: this.#options.check });
    for (const p of parsed.problems) this.#problem('assembly/restricted-html', p.pointer, p.message);
    if (parsed.problems.length) return;
    const origin: NodeOrigin = { component: 'html', template: null, instance: [...path, node.key].join('/'), plan: node.pointer, source: 'html' };
    for (const n of parsed.nodes) this.#adopt(n, parent, origin);
    this.#built.gaps.push({ instance: origin.instance, plan: node.pointer });
  }

  async #markup(value: string, kind: 'inline' | 'prose', parent: ParentNode, context: Element | null, frame: Frame, pointer: string): Promise<void> {
    const where = isElement(parent as Node) ? (parent as Element) : context;
    const parsed = await parseRestricted(value, kind, where?.tagName ?? 'body', pointer, { values: this.#options.values, check: this.#options.check });
    for (const p of parsed.problems) this.#problem('assembly/restricted-html', p.pointer, p.message);
    if (parsed.problems.length) return;
    for (const { element, relative } of parsed.headings) {
      const level = frame.current + 1 + relative;
      if (level > 6) this.#problem('assembly/heading-depth', pointer, `a prose heading would be level ${level}, past <h6>; ${this.#shallower()}.`);
      element.tagName = element.nodeName = `h${Math.min(level, 6)}`;
    }
    const origin = this.#origin(frame, null, 'data', pointer);
    for (const n of parsed.nodes) this.#adopt(n, parent, origin);
  }

  /** Moves parsed nodes into the tree, recording where they came from. */
  #adopt(node: ChildNode, parent: ParentNode, origin: NodeOrigin): void {
    for (const { node: n } of walk(node)) if (isElement(n)) this.#built.origins.set(n, origin);
    tree.detachNode(node);
    tree.appendChild(parent, node);
  }

  /** Cross-instance refs, then ID collisions over the whole tree. */
  #finish(): void {
    for (const r of this.#refs) {
      const target = this.#instances.get(r.ref);
      if (!target && this.#built.gaps.some((g) => g.instance === r.ref)) this.#problem('assembly/ref', r.pointer, `{ "ref": "${r.ref}" } names an HTML node; a ref names a component instance whose component has id="@".`);
      else if (!target) this.#problem('assembly/ref', r.pointer, `{ "ref": "${r.ref}" } names no instance in the plan; a key path lists keys from the top of the plan down, such as "contact/email".`);
      else if (!target.id) this.#problem('assembly/ref', r.pointer, `{ "ref": "${r.ref}" } names an instance whose component has no id="@"; refer to one that does.`);
      settle(r.element, r.attr, target?.id ? (r.href ? `#${target.id}` : target.id) : null);
    }
    const seen = new Map<string, Element>();
    for (const { node } of walk(this.#built.root)) {
      if (!isElement(node) || !isHtml(node)) continue;
      const id = node.attrs.find((a) => a.name === 'id')?.value;
      if (id === undefined) continue;
      const first = seen.get(id);
      if (!first) {
        seen.set(id, node);
        continue;
      }
      const a = this.#built.origins.get(first);
      const b = this.#built.origins.get(node);
      this.#problem('assembly/id-collision', b?.plan ?? '', `id="${id}" appears twice, in ${a?.instance || 'the page'} and ${b?.instance || 'the page'}; change a key.`);
    }
  }
}
