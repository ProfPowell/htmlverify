import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, type ChildNode, type Document, type DocumentFragment, type Element } from '../parse/tree.ts';
import type { Options } from '../rules/types.ts';
import { isBooleanAttribute, VOID_ELEMENTS } from '../spec/html.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';
import { preservesWhitespace, whitespaceIgnorable } from './layout.ts';

export interface SerializeOptions {
  voidElements: Options['voidElements'];
  booleanValue: Options['booleanValue'];
  vocabulary: Vocabulary | null;
  /** Presence booleans beyond HTML's, such as the vocabulary's. */
  isBoolean?: (element: Element, name: string) => boolean;
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
 * Other content is written as built, except that whitespace-only text with a
 * line break is re-indented to the depth it sits at. Whitespace thus appears
 * only where it can't render or already was, and trees that differ only in
 * such whitespace serialize alike.
 */
export function serialize(root: Document | DocumentFragment, options: SerializeOptions): string {
  const writer = new Writer(options);
  if (root.nodeName === '#document') writer.document(root as Document);
  else writer.fragment(childrenOf(root));
  return writer.out.join('');
}

class Writer {
  readonly out: string[] = [];
  readonly #options: SerializeOptions;

  constructor(options: SerializeOptions) {
    this.#options = options;
  }

  document(doc: Document): void {
    for (const node of doc.childNodes) {
      if (node.nodeName === '#documentType') this.out.push(doctype(node as unknown as { name: string; publicId: string; systemId: string }));
      else if (isElement(node)) this.element(node, 0, false);
      else if (isComment(node)) this.child(node, 0, false);
      else continue;
      this.out.push('\n');
    }
  }

  fragment(children: readonly ChildNode[]): void {
    const blocks = this.#blocks(null, children);
    if (blocks) {
      for (const c of blocks) {
        this.child(c, 0, false);
        this.out.push('\n');
      }
      return;
    }
    this.inline(children, 0, 0);
    // Trailing text keeps its own ending: a line break after it would join it.
    const last = children.at(-1);
    if (!(last && isText(last) && (!isWhitespaceText(last) || last.value.includes('\n')))) this.out.push('\n');
  }

  element(e: Element, depth: number, preserve: boolean): void {
    const name = e.tagName;
    const html = isHtml(e);
    const children = childrenOf(e);
    const open = `<${name}${this.#attributes(e)}`;
    if (html && VOID_ELEMENTS.has(name)) {
      this.out.push(open, this.#options.voidElements === 'html' ? '>' : this.#options.voidElements === 'tight' ? '/>' : ' />');
      return;
    }
    if (!html && children.length === 0) {
      this.out.push(open, this.#options.voidElements === 'tight' ? '/>' : ' />');
      return;
    }
    this.out.push(open, '>');
    if (html && RAW_TEXT.has(name)) {
      for (const c of children) if (isText(c)) this.out.push(c.value);
    } else if (preserve || preservesWhitespace(e)) {
      const first = children[0];
      if (html && LEADING_NEWLINE.has(name) && first && isText(first) && first.value.startsWith('\n')) this.out.push('\n');
      for (const c of children) this.child(c, depth, true);
    } else {
      const inner = html && name === 'html' ? depth : depth + 1;
      const blocks = this.#blocks(e, children);
      if (blocks) {
        for (const c of blocks) {
          this.out.push('\n', INDENT.repeat(inner));
          this.child(c, inner, false);
        }
        this.out.push('\n', INDENT.repeat(depth));
      } else {
        this.inline(children, inner, depth);
      }
    }
    this.out.push(`</${name}>`);
  }

  /** Content written as built; a line break in whitespace-only text is re-indented. */
  inline(children: readonly ChildNode[], inner: number, depth: number): void {
    children.forEach((c, i) => {
      if (isWhitespaceText(c) && /\n/.test((c as { value: string }).value)) {
        this.out.push('\n', INDENT.repeat(i === children.length - 1 ? depth : inner));
      } else {
        this.child(c, inner, false);
      }
    });
  }

  child(node: ChildNode, depth: number, preserve: boolean): void {
    if (isElement(node)) this.element(node, depth, preserve);
    else if (isText(node)) this.out.push(node.value.replace(/[&<> ]/g, (ch) => TEXT_ENTITIES[ch]!));
    else if (isComment(node)) this.out.push(`<!--${(node as { data: string }).data}-->`);
  }

  /** The children to write one per line, or null when the content is written inline. */
  #blocks(parent: Element | null, children: readonly ChildNode[]): ChildNode[] | null {
    if (!whitespaceIgnorable(parent, children, this.#options.vocabulary)) return null;
    const blocks = children.filter((c) => !isWhitespaceText(c));
    return blocks.length > 0 ? blocks : null;
  }

  #attributes(e: Element): string {
    let s = '';
    for (const a of e.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      if (!a.namespace && this.#isBoolean(e, a.name)) {
        const form = this.#options.booleanValue;
        s += ` ${name}="${form === 'true' ? 'true' : form === 'name' ? name : ''}"`;
      } else {
        s += ` ${name}="${a.value.replace(/[&"<> ]/g, (ch) => ATTRIBUTE_ENTITIES[ch]!)}"`;
      }
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
