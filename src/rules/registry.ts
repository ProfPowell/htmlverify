import type { RuleMeta } from './types.ts';

const PARSING = 'https://html.spec.whatwg.org/multipage/parsing.html';
const SYNTAX = 'https://html.spec.whatwg.org/multipage/syntax.html';

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
  { id: 'content/attribute-value', authority: 'standard', summary: 'Invalid attribute value (boolean attributes in M0)', ref: 'https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#boolean-attributes' },
];

export const RULE_BY_ID: ReadonlyMap<string, RuleMeta> = new Map(RULES.map((r) => [r.id, r]));
