import { Parser, defaultTreeAdapter, html, type DefaultTreeAdapterMap, type ParserError, type ParserOptions, type Token } from 'parse5';
import type { Document, DocumentFragment, Element } from './tree.ts';

export interface TagToken {
  kind: 'start' | 'end';
  /** Lowercased name, as the tokenizer reports it. */
  name: string;
  offset: number;
  endOffset: number;
  selfClosing: boolean;
}

export interface ParseErrorInfo {
  code: string;
  offset: number;
  endOffset: number;
}

export interface Parsed {
  kind: 'document' | 'fragment';
  root: Document | DocumentFragment;
  /** The fragment's context element; null for documents. */
  context: Element | null;
  /** Every tag token the tree builder consumed, in source order. */
  tokens: TagToken[];
  errors: ParseErrorInfo[];
}

/** The parser version whose behavior the rules and fixtures are pinned to. */
export const PARSER = 'parse5@8.0.1';

/**
 * Parses a document, or a fragment when `context` names a context element.
 * Wrapping the parser's token handlers records each tag token exactly as the
 * tree builder sees it, with tokenizer states (script, RCDATA, foreign content)
 * already applied.
 */
export function parseHtml(text: string, context: string | null): Parsed {
  const errors: ParseErrorInfo[] = [];
  const options: ParserOptions<DefaultTreeAdapterMap> = {
    sourceCodeLocationInfo: true,
    onParseError: (e: ParserError) => errors.push({ code: e.code, offset: e.startOffset, endOffset: e.endOffset }),
  };
  const contextElement = context === null ? null : defaultTreeAdapter.createElement(context, namespaceOf(context), []);
  const parser = contextElement === null
    ? new Parser<DefaultTreeAdapterMap>(options)
    : Parser.getFragmentParser<DefaultTreeAdapterMap>(contextElement, options);

  const tokens: TagToken[] = [];
  const record = (kind: TagToken['kind'], token: Token.TagToken) =>
    tokens.push({
      kind,
      name: token.tagName,
      offset: token.location?.startOffset ?? -1,
      endOffset: token.location?.endOffset ?? -1,
      selfClosing: token.selfClosing,
    });
  const onStartTag = parser.onStartTag.bind(parser);
  const onEndTag = parser.onEndTag.bind(parser);
  parser.onStartTag = (token) => {
    record('start', token);
    onStartTag(token);
  };
  parser.onEndTag = (token) => {
    record('end', token);
    onEndTag(token);
  };

  parser.tokenizer.write(text, true);
  return contextElement === null
    ? { kind: 'document', root: parser.document, context: null, tokens, errors }
    : { kind: 'fragment', root: parser.getFragment(), context: contextElement, tokens, errors };
}

function namespaceOf(tag: string): html.NS {
  if (tag === 'svg') return html.NS.SVG;
  if (tag === 'math') return html.NS.MATHML;
  return html.NS.HTML;
}
