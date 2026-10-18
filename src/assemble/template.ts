// Component templates (spec §9.3): HTML parsed in the component's context,
// with {{…}} bindings and vb- directives, compiled to a tree the assembler
// instantiates. Every problem is reported at once, located in template.html.

import { LineIndex } from '../parse/lines.ts';
import { parseHtml } from '../parse/parse.ts';
import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, type ChildNode, type Element, type Node, type TextNode } from '../parse/tree.ts';
import { PARSE_ERROR_MESSAGES } from '../rules/syntax.ts';
import { readAttribute } from '../rules/util.ts';
import { ariaValueProblem, attributeData } from '../spec/aria.ts';
import { attributeRow, HTML_ELEMENTS, isEventHandler } from '../spec/data.ts';
import { isBooleanAttribute } from '../spec/html.ts';
import { modelOf } from '../spec/model.ts';
import { valueProblem } from '../spec/values.ts';
import { closest, words } from '../text.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import { isPage, type Contract } from './contract.ts';
import { inlineLevel, preservesWhitespace } from './layout.ts';
import { NAME, type ParamSpec, type ParamType } from './params.ts';

export interface Loc {
  line: number;
  column: number;
}

/** A parameter, or a field of the item a vb-each names. */
export interface Path {
  root: string;
  field: string | null;
}

export type IdToken = { symbol: string } | { literal: string };

export type TAttr =
  | { kind: 'static'; name: string; value: string; namespace: string | null; prefix: string | null }
  /** The whole value is one parameter; a boolean attribute is present or omitted. */
  | { kind: 'value'; name: string; path: Path; type: ParamType; boolean: boolean; loc: Loc; accepts?: readonly string[] }
  /** Text and parameters, in a text attribute or class. */
  | { kind: 'mixed'; name: string; parts: (string | Path)[]; loc: Loc }
  /** An ID or ID references with @ symbols, and literal IDs in page components. */
  | { kind: 'ids'; name: string; tokens: IdToken[]; single: boolean; loc: Loc }
  /** href="#@name": a link to a symbol's element. */
  | { kind: 'fragment'; name: string; symbol: string; loc: Loc };

export type TNode =
  | { kind: 'element'; name: string; namespace: string; attrs: TAttr[]; children: TNode[]; inline: boolean; preserve: boolean; rank: number | null; loc: Loc }
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: Path; type: ParamType; loc: Loc }
  | { kind: 'if'; path: Path; negate: boolean; children: TNode[]; loc: Loc }
  | { kind: 'each'; path: Path; as: string; children: TNode[]; loc: Loc }
  | { kind: 'slot'; name: string; loc: Loc }
  | { kind: 'doctype'; name: string; publicId: string; systemId: string };

export interface CompiledTemplate {
  /** The parent element the template was parsed in, or "document". */
  context: string;
  nodes: TNode[];
  /** Local ID symbols the template defines; "" is the instance's own ID. */
  symbols: ReadonlySet<string>;
}

export interface TemplateProblem extends Loc {
  message: string;
}

export class TemplateError extends Error {
  readonly problems: readonly TemplateProblem[];
  constructor(file: string, problems: readonly TemplateProblem[]) {
    super(problems.map((p) => `${file}:${p.line}:${p.column}: ${p.message}`).join('\n'));
    this.problems = problems;
  }
}

/** Attributes whose value is plain text (spec §9.5). */
const TEXT_ATTRIBUTES = new Set(['alt', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'name', 'value', 'content', 'label', 'abbr']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'cite', 'poster', 'data']);
const NEVER_BOUND = new Set(['style', 'srcdoc', 'srcset', 'sizes', 'imagesrcset', 'imagesizes']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const RCDATA = new Set(['title', 'textarea']);
const HEADING = /^h[1-6]$/;
const SYMBOL = /^@(?:[a-z][a-z0-9-]*)?$/;
const BINDING = /\{\{([^{}]*)\}\}/g;
const PATH = /^([a-z][a-zA-Z0-9]*)(?:\.([a-z][a-zA-Z0-9]*))?$/;

/** Parse errors the syntax rules explain as findings of their own. */
const TEMPLATE_PARSE_ERRORS: Record<string, string> = {
  'non-void-html-element-start-tag-with-trailing-solidus': '"/>" doesn’t close a non-void element, so it swallows what follows; write the end tag, such as <template vb-slot="…"></template>.',
};

/** ID-reference attributes: one ID, or a space-separated list. */
function idReferences(element: string, name: string): 'single' | 'list' | null {
  if (name === 'for') return element === 'output' ? 'list' : element === 'label' ? 'single' : null;
  if (['list', 'form', 'commandfor', 'popovertarget', 'aria-activedescendant'].includes(name)) return 'single';
  if (['aria-describedby', 'aria-labelledby', 'aria-controls', 'aria-owns', 'aria-details', 'aria-errormessage', 'aria-flowto', 'headers', 'itemref'].includes(name)) return 'list';
  return null;
}

interface ScopeVar {
  name: string;
  items: ParamType | Record<string, ParamSpec>;
}

/**
 * Compiles a template against its contract: every parameter used is
 * declared and every declared one is used; bindings sit only in sinks their
 * type fits; IDs are @ symbols and headings are ranked, except in page
 * components. Throws a TemplateError listing every problem.
 */
export function compileTemplate(source: string, contract: Contract, vocabulary: Vocabulary, file = 'template.html'): CompiledTemplate {
  return new Compiler(source, contract, vocabulary).run(file);
}

class Compiler {
  readonly #source: string;
  readonly #contract: Contract;
  readonly #vocabulary: Vocabulary;
  readonly #page: boolean;
  readonly #lines: LineIndex;
  readonly #problems: TemplateProblem[] = [];
  readonly #usedParams = new Set<string>();
  readonly #usedSlots = new Set<string>();
  readonly #symbols = new Map<string, Loc>();
  readonly #references: { symbol: string; loc: Loc }[] = [];

  constructor(source: string, contract: Contract, vocabulary: Vocabulary) {
    this.#source = source;
    this.#contract = contract;
    this.#vocabulary = vocabulary;
    this.#page = isPage(contract);
    this.#lines = new LineIndex(source);
  }

  run(file: string): CompiledTemplate {
    const parsed = parseHtml(this.#source, this.#page ? null : this.#contract.context);
    for (const e of parsed.errors) this.#report(this.#at(e.offset), TEMPLATE_PARSE_ERRORS[e.code] ?? PARSE_ERROR_MESSAGES[e.code] ?? `Parse error: ${e.code}.`);
    const nodes = this.#nodes(childrenOf(parsed.root), this.#page ? null : parsed.context, [], false);

    for (const name of Object.keys(this.#contract.params)) {
      if (!this.#usedParams.has(name)) this.#report({ line: 1, column: 1 }, `"${name}" is declared but never used; use it, or remove it from component.json`);
    }
    for (const name of Object.keys(this.#contract.slots)) {
      if (!this.#usedSlots.has(name)) this.#report({ line: 1, column: 1 }, `the slot "${name}" is declared but has no <template vb-slot="${name}">`);
    }
    for (const r of this.#references) {
      if (!this.#symbols.has(r.symbol)) {
        const near = closest(r.symbol, [...this.#symbols.keys()].filter(Boolean));
        this.#report(r.loc, `${r.symbol ? `@${r.symbol}` : '@'} isn’t defined: give an element id="${r.symbol ? `@${r.symbol}` : '@'}"${near ? `, or did you mean @${near}?` : '.'}`);
      }
    }
    if (this.#problems.length) {
      this.#problems.sort((a, b) => a.line - b.line || a.column - b.column);
      throw new TemplateError(file, this.#problems);
    }
    normalize(nodes, false);
    trimEdges(nodes);
    return { context: this.#page ? 'document' : this.#contract.context, nodes, symbols: new Set(this.#symbols.keys()) };
  }

  #at(offset: number): Loc {
    const p = this.#lines.position(offset);
    return { line: p.line, column: p.column };
  }

  #report(loc: Loc, message: string): void {
    this.#problems.push({ ...loc, message });
  }

  #loc(node: Node): Loc {
    const l = (node as { sourceCodeLocation?: { startOffset: number } | null }).sourceCodeLocation;
    return l ? this.#at(l.startOffset) : { line: 1, column: 1 };
  }

  /** Compiles a sequence of children; `parent` is the element they sit in once directives are expanded. */
  #nodes(children: readonly ChildNode[], parent: Element | null, scope: ScopeVar[], inEach: boolean): TNode[] {
    const out: TNode[] = [];
    for (const child of children) {
      if (child.nodeName === '#documentType') {
        const d = child as unknown as { name: string; publicId: string; systemId: string };
        out.push({ kind: 'doctype', name: d.name, publicId: d.publicId ?? '', systemId: d.systemId ?? '' });
      } else if (isComment(child)) {
        if ((child as { data: string }).data.includes('{{')) this.#report(this.#loc(child), 'No bindings in comments; comments aren’t written to the output.');
      } else if (isText(child)) {
        out.push(...this.#text(child, parent, scope, children));
      } else if (isElement(child)) {
        const directive = isHtml(child) && child.tagName === 'template' && child.attrs.some((a) => a.name.startsWith('vb-'));
        const node = directive ? this.#directive(child, parent, scope, inEach) : this.#element(child, scope, inEach);
        if (node) out.push(node);
      }
    }
    return out;
  }

  #text(node: TextNode, parent: Element | null, scope: ScopeVar[], siblings: readonly ChildNode[]): TNode[] {
    const location = node.sourceCodeLocation;
    if (!location) return [{ kind: 'text', value: node.value }];
    const raw = this.#source.slice(location.startOffset, location.endOffset);
    const tag = parent && isHtml(parent) ? parent.tagName : null;
    if (tag && RAW_TEXT.has(tag)) {
      if (raw.includes('{{')) this.#report(this.#at(location.startOffset), `No bindings in <${tag}>.`);
      return [{ kind: 'text', value: node.value }];
    }
    const matches = [...raw.matchAll(BINDING)];
    this.#unclosed(raw, matches, location.startOffset);
    if (matches.length === 0) return [{ kind: 'text', value: node.value }];
    const rcdata = tag !== null && RCDATA.has(tag);
    const out: TNode[] = [];
    let last = 0;
    for (const m of matches) {
      if (m.index > last) out.push({ kind: 'text', value: decode(raw.slice(last, m.index), rcdata ? 'rcdata' : 'data') });
      last = m.index + m[0].length;
      const loc = this.#at(location.startOffset + m.index);
      const resolved = this.#resolve(m[1]!, scope, loc);
      if (!resolved) continue;
      const type = resolved.spec.type;
      const sole = raw.trim() === m[0] && siblings.every((s) => s === node || isWhitespaceText(s));
      if (type === 'text') out.push({ kind: 'value', path: resolved.path, type, loc });
      else if (type === 'inline' && !rcdata && tag !== 'option' && (parent === null || isHtml(parent) || this.#vocabulary.get(parent.tagName))) out.push({ kind: 'value', path: resolved.path, type, loc });
      else if (type === 'prose' && sole && parent !== null && acceptsFlow(parent, this.#vocabulary)) out.push({ kind: 'value', path: resolved.path, type, loc });
      else {
        const why = type === 'prose'
          ? 'a prose parameter must be the only content of a flow container, such as <section> or <li>'
          : type === 'inline'
            ? `an inline parameter can’t go in <${tag}>, which takes only text`
            : `text positions take text, inline, or prose parameters, not ${type}`;
        this.#report(loc, `{{${m[1]!.trim()}}}: ${why}.`);
      }
    }
    if (last < raw.length) out.push({ kind: 'text', value: decode(raw.slice(last), rcdata ? 'rcdata' : 'data') });
    return out;
  }

  /** Reports a "{{" with no closing "}}". */
  #unclosed(raw: string, matches: RegExpMatchArray[], offset: number): void {
    let i = raw.indexOf('{{');
    while (i !== -1) {
      const inside = matches.some((m) => i >= m.index! && i < m.index! + m[0].length);
      if (!inside) {
        this.#report(this.#at(offset + i), '"{{" isn’t closed with "}}"; write &#123;&#123; for literal braces.');
        return;
      }
      i = raw.indexOf('{{', i + 1);
    }
  }

  #resolve(text: string, scope: ScopeVar[], loc: Loc): { path: Path; spec: ParamSpec } | null {
    const m = PATH.exec(text.trim());
    if (!m) {
      this.#report(loc, `{{${text.trim()}}} isn’t a binding: write a parameter name, or item.field inside vb-each; there are no expressions.`);
      return null;
    }
    const [, root, field] = m as unknown as [string, string, string | undefined];
    for (let i = scope.length - 1; i >= 0; i--) {
      const v = scope[i]!;
      if (v.name !== root) continue;
      if (typeof v.items === 'string') {
        if (field) {
          this.#report(loc, `{{${root}.${field}}}: the items of this list are ${v.items} values, which have no fields; write {{${root}}}.`);
          return null;
        }
        return { path: { root, field: null }, spec: { type: v.items, required: true } };
      }
      if (!field) {
        this.#report(loc, `{{${root}}} is a record; name one of its fields, such as {{${root}.${Object.keys(v.items)[0]}}}.`);
        return null;
      }
      const spec = v.items[field];
      if (!spec) {
        const near = closest(field, Object.keys(v.items));
        this.#report(loc, `{{${root}.${field}}}: the items have no field "${field}"${near ? `; did you mean ${root}.${near}?` : '.'}`);
        return null;
      }
      return { path: { root, field }, spec };
    }
    const spec = this.#contract.params[root];
    if (!spec) {
      const near = closest(root, Object.keys(this.#contract.params));
      this.#report(loc, `{{${text.trim()}}}: "${root}" isn’t declared in component.json${near ? `; did you mean "${near}"?` : '.'}`);
      return null;
    }
    this.#usedParams.add(root);
    if (field) {
      this.#report(loc, `{{${root}.${field}}}: parameters have no fields; fields belong to list items inside vb-each.`);
      return null;
    }
    return { path: { root, field: null }, spec };
  }

  #directive(t: Element, parent: Element | null, scope: ScopeVar[], inEach: boolean): TNode | null {
    const loc = this.#loc(t);
    const attrs = new Map(t.attrs.map((a) => [a.name, a.value]));
    const kinds = ['vb-if', 'vb-each', 'vb-slot'].filter((k) => attrs.has(k));
    for (const name of attrs.keys()) {
      if (!['vb-if', 'vb-each', 'vb-as', 'vb-slot'].includes(name)) {
        const near = name.startsWith('vb-') ? closest(name, ['vb-if', 'vb-each', 'vb-as', 'vb-slot']) : null;
        this.#report(loc, name.startsWith('vb-') ? `${name} isn’t a directive${near ? `; did you mean ${near}?` : '.'}` : `A directive <template> takes no other attributes (${name}).`);
      }
    }
    if (kinds.length !== 1) {
      this.#report(loc, 'A directive <template> takes exactly one of vb-if, vb-each, or vb-slot.');
      return null;
    }
    const contents = childrenOf(t);
    const kind = kinds[0]!;
    if (kind === 'vb-slot') {
      const name = attrs.get('vb-slot')!;
      if (attrs.has('vb-as')) this.#report(loc, 'vb-as goes with vb-each.');
      if (!this.#contract.slots[name]) {
        const near = closest(name, Object.keys(this.#contract.slots));
        this.#report(loc, `The slot "${name}" isn’t declared in component.json${near ? `; did you mean "${near}"?` : '.'}`);
        return null;
      }
      if (this.#usedSlots.has(name)) this.#report(loc, `The slot "${name}" appears twice; a slot has one place.`);
      if (inEach) this.#report(loc, `The slot "${name}" is inside vb-each, so its children would repeat; move it out.`);
      if (contents.some((c) => !isWhitespaceText(c))) this.#report(loc, `<template vb-slot="${name}"> must be empty; the plan supplies its children.`);
      this.#usedSlots.add(name);
      return { kind: 'slot', name, loc };
    }
    if (kind === 'vb-if') {
      if (attrs.has('vb-as')) this.#report(loc, 'vb-as goes with vb-each.');
      const raw = attrs.get('vb-if')!.trim();
      const negate = raw.startsWith('!');
      const resolved = this.#resolve(negate ? raw.slice(1) : raw, scope, loc);
      if (!resolved) return null;
      const { spec } = resolved;
      if (spec.type !== 'boolean' && (spec.required || spec.default !== undefined)) {
        this.#report(loc, `vb-if="${raw}": "${negate ? raw.slice(1) : raw}" is always present; vb-if takes a boolean or an optional parameter without a default.`);
      }
      return { kind: 'if', path: resolved.path, negate, children: this.#nodes(contents, parent, scope, inEach), loc };
    }
    const as = attrs.get('vb-as');
    const raw = attrs.get('vb-each')!.trim();
    const resolved = this.#resolve(raw, scope, loc);
    if (!resolved) return null;
    if (resolved.spec.type !== 'list') {
      this.#report(loc, `vb-each="${raw}": "${raw}" is ${resolved.spec.type}, not a list.`);
      return null;
    }
    if (as === undefined || !NAME.test(as)) {
      this.#report(loc, `vb-each needs vb-as naming each item, such as vb-as="item".`);
      return null;
    }
    if (this.#contract.params[as] || scope.some((v) => v.name === as)) this.#report(loc, `vb-as="${as}" hides a parameter or an outer item of the same name; pick another name.`);
    const children = this.#nodes(contents, parent, [...scope, { name: as, items: resolved.spec.items! }], true);
    return { kind: 'each', path: resolved.path, as, children, loc };
  }

  #element(e: Element, scope: ScopeVar[], inEach: boolean): TNode {
    const loc = this.#loc(e);
    const html = isHtml(e);
    const tag = e.tagName;
    if (html && !HTML_ELEMENTS.has(tag) && !this.#vocabulary.get(tag) && !this.#vocabulary.isAdHoc(tag)) {
      const near = closest(tag, [...HTML_ELEMENTS, ...this.#vocabulary.customNames()]);
      this.#report(loc, `<${tag}> isn’t an HTML element or one of the configured vocabulary’s${near ? `; did you mean <${near}>?` : '.'}`);
    }
    let rank: number | null = null;
    const rankAttr = e.attrs.find((a) => a.name === 'vb-rank');
    if (rankAttr) {
      if (!(html && HEADING.test(tag))) this.#report(loc, 'vb-rank goes on a heading, h1 to h6.');
      else if (rankAttr.value === '' || rankAttr.value === 'true') rank = 1;
      else if (/^\+[1-5]$/.test(rankAttr.value)) rank = Number(rankAttr.value.slice(1));
      else this.#report(loc, `vb-rank="${rankAttr.value}" must be empty or +1 to +5.`);
    } else if (html && HEADING.test(tag) && !this.#page) {
      this.#report(loc, `A literal <${tag}> fixes its level; write <${tag} vb-rank> so the level comes from where the component sits.`);
    }
    const attrs = this.#attributes(e, scope, inEach);
    const preserve = preservesWhitespace(e);
    const children = this.#nodes(childrenOf(e), e, scope, inEach);
    return { kind: 'element', name: tag, namespace: e.namespaceURI, attrs, children, inline: inlineLevel(e, this.#vocabulary), preserve, rank, loc };
  }

  #attributes(e: Element, scope: ScopeVar[], inEach: boolean): TAttr[] {
    const out: TAttr[] = [];
    const html = isHtml(e);
    const tag = e.tagName;
    const locations = e.sourceCodeLocation?.attrs ?? {};
    for (const a of e.attrs) {
      if (a.name === 'vb-rank') continue;
      const location = locations[a.prefix ? `${a.prefix}:${a.name}` : a.name];
      const loc = location ? this.#at(location.startOffset) : this.#loc(e);
      const name = a.name;
      if (name.includes('{{')) {
        this.#report(loc, 'No bindings in attribute names.');
        continue;
      }
      if (name.startsWith('vb-')) {
        this.#report(loc, `${name} isn’t a directive here; directives go on <template>, and vb-rank on headings.`);
        continue;
      }
      const raw = location ? readAttribute(this.#source, location.startOffset) : null;
      const rawValue = raw ? this.#source.slice(raw.valueOffset, raw.valueEndOffset) : a.value;
      const matches = [...rawValue.matchAll(BINDING)];
      if (raw) this.#unclosed(rawValue, matches, raw.valueOffset);
      if (a.namespace || !html) {
        if (matches.length) this.#report(loc, 'No bindings in foreign content attributes.');
        out.push({ kind: 'static', name, value: a.value, namespace: a.namespace ?? null, prefix: a.prefix ?? null });
        continue;
      }
      if (!this.#known(e, name)) {
        const near = closest(name, html ? [] : Object.keys(this.#vocabulary.get(tag)?.element.attributes ?? {}));
        this.#report(loc, `${name} isn’t an attribute of <${tag}>${near ? `; did you mean ${near}?` : '.'}`);
        continue;
      }
      if (matches.length && (name.startsWith('on') || NEVER_BOUND.has(name))) {
        this.#report(loc, `${name} can’t take a binding.`);
        continue;
      }
      const references = html ? idReferences(tag, name) : null;
      if (matches.length === 0) {
        out.push(this.#staticAttribute(e, name, a.value, references, loc, inEach));
        continue;
      }
      if (name === 'id') {
        this.#report(loc, 'An id is an @ symbol, such as id="@input", not a binding.');
        continue;
      }
      const whole = matches.length === 1 && matches[0]![0] === rawValue;
      if (whole) {
        const resolved = this.#resolve(matches[0]![1]!, scope, loc);
        if (!resolved) continue;
        const why = this.#sink(e, name, resolved.spec);
        if (why) this.#report(loc, `${name}="${rawValue}": ${why}`);
        else out.push({ kind: 'value', name, path: resolved.path, type: resolved.spec.type, boolean: this.#isBoolean(e, name), loc, ...(resolved.spec.accepts ? { accepts: resolved.spec.accepts } : {}) });
        continue;
      }
      if (!(TEXT_ATTRIBUTES.has(name) || name.startsWith('data-') || name === 'class')) {
        this.#report(loc, `${name}: only text attributes and class take text around a binding; bind the whole value.`);
        continue;
      }
      const parts: (string | Path)[] = [];
      let last = 0;
      for (const m of matches) {
        if (m.index > last) parts.push(decodeAttribute(rawValue.slice(last, m.index), raw?.quote));
        last = m.index + m[0].length;
        const resolved = this.#resolve(m[1]!, scope, loc);
        if (!resolved) continue;
        const allowed = name === 'class' ? ['enum'] : ['text', 'enum'];
        if (!allowed.includes(resolved.spec.type)) this.#report(loc, `${name}: a binding inside a longer value must be ${words(allowed)}, not ${resolved.spec.type}.`);
        parts.push(resolved.path);
      }
      if (last < rawValue.length) parts.push(decodeAttribute(rawValue.slice(last), raw?.quote));
      out.push({ kind: 'mixed', name, parts, loc });
    }
    return out;
  }

  #staticAttribute(e: Element, name: string, value: string, references: 'single' | 'list' | null, loc: Loc, inEach: boolean): TAttr {
    const html = isHtml(e);
    if (name === 'id') {
      if (SYMBOL.test(value)) {
        const symbol = value.slice(1);
        if (inEach) this.#report(loc, `id="${value}" is inside vb-each, so it would repeat; give each item its own component, or drop the id.`);
        if (this.#symbols.has(symbol)) this.#report(loc, `id="${value}" is defined twice.`);
        this.#symbols.set(symbol, loc);
        return { kind: 'ids', name, tokens: [{ symbol }], single: true, loc };
      }
      if (!this.#page) this.#report(loc, `id="${value}" is fixed, so a second instance would repeat it; write an @ symbol, such as id="@${slug(value)}".`);
      return { kind: 'static', name, value, namespace: null, prefix: null };
    }
    if (references) {
      const tokens = value.split(/[\t\n\f\r ]+/).filter(Boolean);
      if (tokens.some((t) => t.startsWith('@'))) {
        const out: IdToken[] = [];
        for (const t of tokens) {
          if (SYMBOL.test(t)) {
            this.#references.push({ symbol: t.slice(1), loc });
            out.push({ symbol: t.slice(1) });
          } else if (!this.#page) {
            this.#report(loc, `${name}="${value}": "${t}" is a fixed ID; refer to @ symbols, or bind a ref parameter.`);
          } else out.push({ literal: t });
        }
        if (references === 'single' && tokens.length !== 1) this.#report(loc, `${name} takes one ID.`);
        return { kind: 'ids', name, tokens: out, single: references === 'single', loc };
      }
      if (!this.#page && tokens.length) this.#report(loc, `${name}="${value}" refers to fixed IDs; refer to @ symbols, or bind a ref parameter.`);
    }
    if (html && name === 'href' && /^#@/.test(value)) {
      const symbol = value.slice(2);
      if (!/^(?:[a-z][a-z0-9-]*)?$/.test(symbol)) this.#report(loc, `href="${value}" names no symbol.`);
      this.#references.push({ symbol, loc });
      return { kind: 'fragment', name, symbol, loc };
    }
    return { kind: 'static', name, value, namespace: null, prefix: null };
  }

  /** Whether an attribute exists on the element (spec data plus the vocabulary). */
  #known(e: Element, name: string): boolean {
    const tag = e.tagName;
    if (name.startsWith('data-') || name === 'role') return true;
    if (name.startsWith('aria-')) return attributeData(name) !== null;
    if (isHtml(e) && attributeRow(tag, name)) return true;
    if (isEventHandler(tag, name)) return true;
    if (this.#vocabulary.isAdHoc(tag)) return true;
    const entry = this.#vocabulary.get(tag);
    return entry !== null && name in entry.element.attributes;
  }

  #isBoolean(e: Element, name: string): boolean {
    if (isBooleanAttribute(e.tagName, name)) return true;
    return this.#vocabulary.get(e.tagName)?.element.attributes[name]?.type === 'boolean';
  }

  /** Why a parameter of this type can't bind this attribute, or null when it fits (spec §9.5). */
  #sink(e: Element, name: string, spec: ParamSpec): string | null {
    const tag = e.tagName;
    const custom = this.#vocabulary.get(tag)?.element.attributes[name] ?? null;
    const row = isHtml(e) ? attributeRow(tag, name) : null;
    const loose = custom !== null && (custom.type === 'string' || custom.type === null);
    switch (spec.type) {
      case 'text':
        return TEXT_ATTRIBUTES.has(name) || name.startsWith('data-') || loose ? null : `${name} isn’t a text attribute; text binds alt, title, aria-label, placeholder, name, value, content, label, and data-* attributes.`;
      case 'url':
        return URL_ATTRIBUTES.has(name) || loose ? null : `${name} doesn’t take a URL.`;
      case 'boolean':
        return this.#isBoolean(e, name) ? null : `${name} isn’t a boolean attribute; for ARIA states, use an enum of "true" and "false".`;
      case 'enum': {
        if (name === 'class') return spec.values!.every((v) => /^[^\t\n\f\r ]+$/.test(v)) ? null : 'class values must be single tokens.';
        if (custom?.type === 'enum' && custom.values) {
          const bad = spec.values!.filter((v) => !custom.values!.includes(v));
          return bad.length ? `<${tag} ${name}> doesn’t accept ${words(bad.map((v) => `"${v}"`))}.` : null;
        }
        if (name.startsWith('aria-')) {
          const bad = spec.values!.filter((v) => ariaValueProblem(name, v) !== null);
          return bad.length ? `${words(bad.map((v) => `"${v}"`))} ${bad.length === 1 ? 'isn’t a valid value' : 'aren’t valid values'} for ${name}.` : null;
        }
        if (row) {
          const bad = spec.values!.filter((v) => valueProblem(e, name, v, row) !== null);
          return bad.length ? `${words(bad.map((v) => `"${v}"`))} ${bad.length === 1 ? 'isn’t a valid value' : 'aren’t valid values'} for ${name} on <${tag}>.` : null;
        }
        // A data-* attribute nothing types takes whatever values its author defines.
        return loose || (custom === null && name.startsWith('data-')) ? null : `${name} doesn’t take keywords.`;
      }
      case 'integer':
        return (row && /integer|floating-point number/i.test(row.value)) || custom?.type === 'number' ? null : `${name} isn’t a numeric attribute.`;
      case 'datetime':
        return name === 'datetime' && ['time', 'ins', 'del'].includes(tag) ? null : 'a datetime binds <time datetime>, <ins datetime>, or <del datetime>.';
      case 'lang':
        return ['lang', 'hreflang', 'srclang'].includes(name) ? null : 'a lang parameter binds lang or hreflang.';
      case 'ref':
        return idReferences(tag, name) || name === 'href' ? null : `${name} doesn’t refer to an ID.`;
      case 'inline':
      case 'prose':
        return `a ${spec.type} parameter is markup and goes in text positions, not attributes.`;
      case 'list':
        return 'a list goes in vb-each.';
    }
  }
}

/** Whether an element's content may be flow content, for prose parameters. */
function acceptsFlow(e: Element, vocabulary: Vocabulary): boolean {
  const entry = vocabulary.get(e.tagName);
  if (entry) return entry.element.permittedContent === null || entry.element.permittedContent.includes('@flow');
  const model = modelOf(e);
  return model !== null && model.variants.some((v) => v.content.includes('@flow'));
}

/** Decodes raw text or RCDATA source, character references included. */
function decode(raw: string, kind: 'data' | 'rcdata'): string {
  const wrap = kind === 'rcdata' ? 'textarea' : 'b';
  const parsed = parseHtml(`<${wrap}>${raw}</${wrap}>`, 'body');
  const element = childrenOf(parsed.root).find(isElement);
  return element ? childrenOf(element).filter(isText).map((t) => t.value).join('') : raw;
}

function decodeAttribute(raw: string, quote: string | undefined): string {
  const q = quote === "'" ? "'" : '"';
  const parsed = parseHtml(`<b title=${q}${raw}${q}></b>`, 'body');
  const element = childrenOf(parsed.root).find(isElement);
  return element?.attrs.find((a) => a.name === 'title')?.value ?? raw;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'id';
}

// --- Whitespace -----------------------------------------------------------

/** Whether whitespace beside a node can't render (spec §9.9); directives are looked through. */
function isBlock(node: TNode): boolean {
  switch (node.kind) {
    case 'element': return !node.inline;
    case 'value': return node.type === 'prose';
    case 'slot':
    case 'doctype': return true;
    default: return false;
  }
}

/** The nodes a sequence expands to, directives looked through. */
function flatten(nodes: readonly TNode[]): TNode[] {
  return nodes.flatMap((n) => (n.kind === 'if' || n.kind === 'each' ? flatten(n.children) : [n]));
}

const isSpace = (n: TNode) => n.kind === 'text' && /^[\t\n\f\r ]*$/.test(n.value);

/**
 * Drops whitespace-only text where it can't render: among children that
 * are all block items once directives are expanded. Elsewhere it stays, and
 * the serializer re-indents it.
 */
function normalize(nodes: TNode[], preserve: boolean): void {
  if (!preserve && flatten(nodes).every((n) => isSpace(n) || isBlock(n))) dropSpace(nodes);
  for (const n of nodes) {
    if (n.kind === 'element') normalize(n.children, preserve || n.preserve);
    else if (n.kind === 'if' || n.kind === 'each') normalizeInside(n.children, preserve);
  }
}

/** Recurses into the elements inside a directive's children, whose own whitespace their container decided. */
function normalizeInside(nodes: TNode[], preserve: boolean): void {
  for (const n of nodes) {
    if (n.kind === 'element') normalize(n.children, preserve || n.preserve);
    else if (n.kind === 'if' || n.kind === 'each') normalizeInside(n.children, preserve);
  }
}

function dropSpace(nodes: TNode[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (isSpace(n)) nodes.splice(i, 1);
    else if (n.kind === 'if' || n.kind === 'each') dropSpace(n.children);
  }
}

/** A template file's own leading and trailing whitespace is never content. */
function trimEdges(nodes: TNode[]): void {
  while (nodes.length && isSpace(nodes[0]!)) nodes.shift();
  while (nodes.length && isSpace(nodes.at(-1)!)) nodes.pop();
  const first = nodes[0];
  const last = nodes.at(-1);
  if (first && (first.kind === 'if' || first.kind === 'each')) trimEdges(first.children);
  if (last && last !== first && (last.kind === 'if' || last.kind === 'each')) trimEdges(last.children);
}
