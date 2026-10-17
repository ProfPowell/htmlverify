import type { RuleMeta } from './types.ts';

const HTML = 'https://html.spec.whatwg.org/multipage';
const PARSING = `${HTML}/parsing.html`;
const SYNTAX = `${HTML}/syntax.html`;

/** Rules implemented in this version. */
export const RULES: readonly RuleMeta[] = [
  { id: 'syntax/parse-error', authority: 'standard', summary: 'Tokenizer parse errors', ref: `${PARSING}#parse-errors` },
  { id: 'syntax/duplicate-attribute', authority: 'standard', summary: 'Repeated attribute; the parser keeps the first', ref: `${PARSING}#parse-error-duplicate-attribute` },
  { id: 'syntax/self-closing-non-void', authority: 'standard', summary: '"/>" on a non-void element, which stays open', ref: `${PARSING}#parse-error-non-void-html-element-start-tag-with-trailing-solidus` },
  { id: 'syntax/unclosed-element', authority: 'standard', summary: 'Element closed by the parser where its end tag isn’t optional', ref: `${SYNTAX}#optional-tags` },
  { id: 'syntax/stray-end-tag', authority: 'standard', summary: 'End tag that matches no open element', ref: `${PARSING}#parsing-main-inbody` },
  { id: 'syntax/misplaced-start-tag', authority: 'standard', summary: 'Start tag the parser dropped or wrapped in an implied element', ref: `${PARSING}#parsing-main-inbody` },
  { id: 'syntax/misnested', authority: 'standard', summary: 'Overlapping elements split by the adoption agency', ref: `${PARSING}#adoption-agency-algorithm` },
  { id: 'syntax/reordered', authority: 'standard', summary: 'Content the parser moved', ref: `${PARSING}#foster-parent` },
  { id: 'syntax/doctype', authority: 'standard', summary: 'Missing or non-conforming doctype', ref: `${SYNTAX}#the-doctype` },
  { id: 'syntax/encoding', authority: 'standard', summary: 'Invalid UTF-8 or a misplaced charset declaration', ref: 'https://html.spec.whatwg.org/multipage/semantics.html#charset' },
  { id: 'style/attr-quotes', authority: 'policy', summary: 'Attribute value not double-quoted', ref: `${SYNTAX}#attributes-2` },
  { id: 'style/boolean-attr', authority: 'policy', summary: 'Boolean attribute not in the house form', ref: 'https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#boolean-attributes' },
  { id: 'style/lowercase', authority: 'policy', summary: 'Names not in canonical case', ref: `${SYNTAX}#syntax-tag-name` },
  { id: 'style/void-element', authority: 'policy', summary: 'Void element not in the configured form', ref: `${SYNTAX}#void-elements` },
  { id: 'style/explicit-start-tag', authority: 'policy', summary: 'Implied html, head, body, tbody, or colgroup', ref: `${SYNTAX}#optional-tags` },
  { id: 'style/explicit-end-tag', authority: 'policy', summary: 'Omitted optional end tag', ref: `${SYNTAX}#optional-tags` },
  { id: 'style/doctype', authority: 'policy', summary: 'Doctype not written <!doctype html>', ref: `${SYNTAX}#the-doctype` },
  { id: 'content/unknown-element', authority: 'standard', summary: 'Neither an HTML element nor a valid custom element name', ref: `${HTML}/indices.html#elements-3` },
  { id: 'content/obsolete', authority: 'standard', summary: 'Obsolete element or attribute', ref: `${HTML}/obsolete.html#non-conforming-features` },
  { id: 'content/unknown-attribute', authority: 'standard', summary: 'Attribute not allowed on the element, or not applicable here', ref: `${HTML}/indices.html#attributes-3` },
  { id: 'content/attribute-value', authority: 'standard', summary: 'Invalid attribute value', ref: `${HTML}/indices.html#attributes-3` },
  { id: 'content/missing-attribute', authority: 'standard', summary: 'Required attribute absent', ref: `${HTML}/dom.html#element-definitions` },
  { id: 'content/child', authority: 'standard', summary: 'Child the parent’s content model doesn’t allow, or a required child missing', ref: `${HTML}/dom.html#content-models` },
  { id: 'content/order', authority: 'standard', summary: 'Child out of order, or the wrong number of a child', ref: `${HTML}/dom.html#content-models` },
  { id: 'content/descendant', authority: 'standard', summary: 'Descendant the ancestor’s content model forbids', ref: `${HTML}/dom.html#content-models` },
  { id: 'content/context', authority: 'standard', summary: 'Element outside the contexts it can be used in', ref: `${HTML}/dom.html#element-definitions` },
  { id: 'content/duplicate-id', authority: 'standard', summary: 'ID used more than once in a scope', ref: `${HTML}/dom.html#the-id-attribute` },
  { id: 'content/invalid-id', authority: 'standard', summary: 'Empty ID, or one containing whitespace', ref: `${HTML}/dom.html#the-id-attribute` },
  { id: 'content/idref', authority: 'standard', summary: 'ID reference that doesn’t resolve, or names the wrong kind of element', ref: `${HTML}/dom.html#the-id-attribute` },
  { id: 'content/document', authority: 'standard', summary: 'More than one visible main, or more than one encoding declaration', ref: `${HTML}/grouping-content.html#the-main-element` },
];

export const RULE_BY_ID: ReadonlyMap<string, RuleMeta> = new Map(RULES.map((r) => [r.id, r]));
