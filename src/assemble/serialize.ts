import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, type ChildNode, type Document, type DocumentFragment, type Element } from '../parse/tree.ts';
import type { Options } from '../rules/types.ts';
import { isBooleanAttribute, VOID_ELEMENTS } from '../spec/html.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import { inlineLevel, insignificant, preservesWhitespace, whitespaceIgnorable } from './layout.ts';

export interface SerializeOptions {
  voidElements: Options['voidElements'];
  booleanValue: Options['booleanValue'];
  vocabulary: Vocabulary | null;
  /** Presence booleans beyond HTML's, such as the vocabulary's. */
  isBoolean?: (element: Element, name: string) => boolean;
  /** A fragment's context element, which decides whether whitespace at its edges can render. */
  context?: Element | null;
}

/** Elements whose text the tokenizer reads raw, so it's written unescaped. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

/** Elements whose first newline the parser drops, so a leading newline is written twice. */
const LEADING_NEWLINE = new Set(['pre', 'textarea', 'listing']);

const INDENT = '  ';
const TEXT_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', ' ': '&nbsp;' };
const ATTRIBUTE_ENTITIES: Record<string, string> = { ...TEXT_ENTITIES, '"': '&quot;' };

/**
 * Writes a tree in the house style (spec §9.9): every start and end tag,
 * double quotes, the configured boolean and void forms, `<!doctype html>`, LF
 * line endings, and a final newline. An element whose children are all block
 * items, apart from whitespace that can't render, gets one child per line,
 * indented two spaces, with the children of `html` kept at its own level.
 * Mixed content is written as built, except that each block-level element
 * gets its own line, whitespace that can't render is dropped, and line breaks
 * in other whitespace are re-indented. Whitespace thus appears only where it
 * can't render or already was, and trees that differ only in such whitespace
 * serialize alike.
 */
export function serialize(root: Document | DocumentFragment, options: SerializeOptions, ranges?: Map<Element, OutputRange>): string {
  const writer = new Writer(options, ranges ?? null);
  if (root.nodeName === '#document') writer.document(root as Document);
  else writer.fragment(childrenOf(root));
  return writer.out.join('');
}

/** Where an element was written: from its start tag's "<" to just past its end tag, and each attribute from its name to its closing quote. */
export interface OutputRange {
  start: number;
  end: number;
  attributes: { name: string; start: number; end: number }[];
}

class Writer {
  readonly out: string[] = [];
  readonly #options: SerializeOptions;
  readonly #ranges: Map<Element, OutputRange> | null;
  #length = 0;

  constructor(options: SerializeOptions, ranges: Map<Element, OutputRange> | null) {
    this.#options = options;
    this.#ranges = ranges;
  }

  #write(...parts: string[]): void {
    for (const p of parts) {
      this.out.push(p);
      this.#length += p.length;
    }
  }

  document(doc: Document): void {
    for (const node of doc.childNodes) {
      if (node.nodeName === '#documentType') this.#write(doctype(node as unknown as { name: string; publicId: string; systemId: string }));
      else if (isElement(node)) this.element(node, 0, false);
      else if (isComment(node)) this.child(node, 0, false);
      else continue;
      this.#write('\n');
    }
  }

  fragment(children: readonly ChildNode[]): void {
    const blocks = this.#blocks(null, children);
    if (blocks) {
      for (const c of blocks) {
        this.child(c, 0, false);
        this.#write('\n');
      }
      return;
    }
    this.#mixed(this.#options.context ?? null, children, 0, 0, false);
    // Trailing text keeps its own ending: a line break after it would join it.
    const last = children.at(-1);
    const tail = this.out.findLast((s) => s !== '') ?? '';
    if (!tail.endsWith('\n') && !(last && isText(last) && !isWhitespaceText(last))) this.#write('\n');
  }

  element(e: Element, depth: number, preserve: boolean): void {
    const range: OutputRange = { start: this.#length, end: 0, attributes: [] };
    this.#element(e, depth, preserve, range);
    range.end = this.#length;
    this.#ranges?.set(e, range);
  }

  #element(e: Element, depth: number, preserve: boolean, range: OutputRange): void {
    const name = e.tagName;
    const html = isHtml(e);
    const children = childrenOf(e);
    const open = `<${name}${this.#attributes(e, range)}`;
    if (html && VOID_ELEMENTS.has(name)) {
      this.#write(open, this.#options.voidElements === 'html' ? '>' : this.#options.voidElements === 'tight' ? '/>' : ' />');
      return;
    }
    if (!html && children.length === 0) {
      this.#write(open, this.#options.voidElements === 'tight' ? '/>' : ' />');
      return;
    }
    this.#write(open, '>');
    if (html && RAW_TEXT.has(name)) {
      for (const c of children) if (isText(c)) this.#write(c.value);
    } else if (preserve || preservesWhitespace(e)) {
      const first = children[0];
      if (html && LEADING_NEWLINE.has(name) && first && isText(first) && first.value.startsWith('\n')) this.#write('\n');
      for (const c of children) this.child(c, depth, true);
    } else {
      const inner = html && name === 'html' ? depth : depth + 1;
      const blocks = this.#blocks(e, children);
      if (blocks) {
        for (const c of blocks) {
          this.#write('\n', INDENT.repeat(inner));
          this.child(c, inner, false);
        }
        this.#write('\n', INDENT.repeat(depth));
      } else {
        this.#mixed(e, children, inner, depth, true);
      }
    }
    this.#write(`</${name}>`);
  }

  /**
   * Mixed content. Line breaks go where whitespace can't render: beside a
   * block-level element, and after the start and before the end of a
   * block-level container that breaks anywhere inside. None goes next to
   * text, which it would join.
   */
  #mixed(parent: Element | null, children: readonly ChildNode[], inner: number, depth: number, open: boolean): void {
    const vocabulary = this.#options.vocabulary;
    const items = children
      .map((c, i) => ({ c, skip: insignificant(children, i, parent, vocabulary), block: isElement(c) && !inlineLevel(c, vocabulary) }))
      .filter((x) => !x.skip);
    const lineBreak = (c: ChildNode) => isText(c) && isWhitespaceText(c) && c.value.includes('\n');
    const edges = items.some((x) => x.block || lineBreak(x.c)) && (parent === null || !inlineLevel(parent, vocabulary));
    let whitespace = false;
    let wanted = edges && open;
    let afterText = false;
    for (const { c, block } of items) {
      if (lineBreak(c)) {
        whitespace = true;
        continue;
      }
      const text = isText(c) && !isWhitespaceText(c);
      if (whitespace || ((wanted || block) && !text && !afterText)) this.#write('\n', INDENT.repeat(inner));
      whitespace = false;
      this.child(c, inner, false);
      wanted = block;
      afterText = text;
    }
    if (whitespace || ((wanted || edges) && !afterText)) this.#write('\n', INDENT.repeat(depth));
  }

  child(node: ChildNode, depth: number, preserve: boolean): void {
    if (isElement(node)) this.element(node, depth, preserve);
    else if (isText(node)) this.#write(node.value.replace(/[&<> ]/g, (ch) => TEXT_ENTITIES[ch]!));
    else if (isComment(node)) this.#write(`<!--${(node as { data: string }).data}-->`);
  }

  /** The children to write one per line, or null when the content is written inline. */
  #blocks(parent: Element | null, children: readonly ChildNode[]): ChildNode[] | null {
    if (!whitespaceIgnorable(parent, children, this.#options.vocabulary)) return null;
    const blocks = children.filter((c) => !isWhitespaceText(c));
    return blocks.length > 0 ? blocks : null;
  }

  /** The attributes as written, recording where each one goes in the output. */
  #attributes(e: Element, range: OutputRange): string {
    let s = '';
    const base = range.start + 1 + e.tagName.length;
    for (const a of e.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      const start = base + s.length + 1;
      if (!a.namespace && this.#isBoolean(e, a.name)) {
        const form = this.#options.booleanValue;
        s += ` ${name}="${form === 'true' ? 'true' : form === 'name' ? name : ''}"`;
      } else {
        s += ` ${name}="${a.value.replace(/[&"<> ]/g, (ch) => ATTRIBUTE_ENTITIES[ch]!)}"`;
      }
      range.attributes.push({ name: a.name, start, end: base + s.length });
    }
    return s;
  }

  #isBoolean(e: Element, name: string): boolean {
    return (isHtml(e) && isBooleanAttribute(e.tagName, name)) || (this.#options.isBoolean?.(e, name) ?? false);
  }
}

function doctype(node: { name: string; publicId: string; systemId: string }): string {
  if (node.publicId) return `<!doctype ${node.name} PUBLIC "${node.publicId}"${node.systemId ? ` "${node.systemId}"` : ''}>`;
  if (node.systemId) return `<!doctype ${node.name} SYSTEM "${node.systemId}">`;
  return `<!doctype ${node.name}>`;
}
