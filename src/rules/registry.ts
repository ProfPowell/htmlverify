import type { RuleMeta } from './types.ts';

const HTML = 'https://html.spec.whatwg.org/multipage';
const WCAG = 'https://www.w3.org/TR/WCAG22/';
const ARIA_IN_HTML = 'https://www.w3.org/TR/html-aria/';
// House rules have no external reference; they point at the spec's own tables.
const HOUSE = 'https://github.com/ProfPowell/htmlverify/blob/main/spec.md#67-policy-house-rules';
const BLOAT = 'https://github.com/ProfPowell/htmlverify/blob/main/spec.md#68-bloat-structural-economy';
const STYLE = 'https://github.com/ProfPowell/htmlverify/blob/main/spec.md#62-style-authored-form-the-tree-is-the-same-either-way';
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
  { id: 'style/escape', authority: 'policy', summary: 'Literal &, <, or > that HTML accepts unescaped', ref: `${SYNTAX}#character-references` },
  { id: 'style/whitespace', authority: 'policy', summary: 'Tab indentation, trailing whitespace, or no single newline at the end', ref: STYLE, options: {
    tabWidth: { type: 'number', integer: true, min: 1, default: 2, summary: 'spaces per tab stop when the fix expands tab indentation' },
  } },
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
  { id: 'a11y/lang', authority: 'standard', summary: 'Page language missing, or a lang value that isn’t well-formed', ref: `${WCAG}#language-of-page` },
  { id: 'a11y/title', authority: 'standard', summary: 'Page title missing or empty', ref: `${WCAG}#page-titled` },
  { id: 'a11y/img-alt', authority: 'standard', summary: 'Image without a text alternative', ref: `${WCAG}#non-text-content` },
  { id: 'a11y/svg', authority: 'standard', summary: 'Inline svg that is neither hidden nor a named image', ref: `${WCAG}#non-text-content` },
  { id: 'a11y/name', authority: 'standard', summary: 'Link, button, frame, dialog, or widget without an accessible name', ref: `${WCAG}#name-role-value` },
  { id: 'a11y/label', authority: 'standard', summary: 'Form control without a programmatic label', ref: `${WCAG}#labels-or-instructions` },
  { id: 'a11y/aria-role', authority: 'standard', summary: 'Unknown, abstract, or disallowed role, or a role outside its required parent', ref: `${ARIA_IN_HTML}#docconformance` },
  { id: 'a11y/aria-attr', authority: 'standard', summary: 'Unknown, deprecated, disallowed, or invalid aria-* attribute, or a missing required state', ref: `${ARIA_IN_HTML}#docconformance` },
  { id: 'a11y/aria-redundant', authority: 'standard', summary: 'Explicit role equal to the implicit one', ref: `${ARIA_IN_HTML}#docconformance` },
  { id: 'a11y/aria-hidden-focus', authority: 'standard', summary: 'Focusable element inside aria-hidden="true"', ref: `${WCAG}#name-role-value` },
  { id: 'a11y/tabindex', authority: 'policy', summary: 'Positive tabindex, or tabindex="0" on an element with no role', ref: `${WCAG}#focus-order` },
  { id: 'a11y/headings', authority: 'standard', summary: 'Empty heading, skipped heading level, or a page that doesn’t start with h1', ref: `${WCAG}#info-and-relationships` },
  { id: 'a11y/landmarks', authority: 'heuristic', summary: 'Repeated landmarks without distinct names; more than one top-level header or footer', ref: 'https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/' },
  { id: 'a11y/link-text', authority: 'heuristic', summary: 'Generic link text such as "click here"', ref: `${WCAG}#link-purpose-in-context` },
  { id: 'a11y/form-group', authority: 'heuristic', summary: 'Radio buttons or checkboxes sharing a name without a group label', ref: `${WCAG}#info-and-relationships` },
  { id: 'a11y/table', authority: 'heuristic', summary: 'Data table without header cells', ref: `${WCAG}#info-and-relationships` },
  { id: 'a11y/media', authority: 'standard', summary: 'Autoplaying sound; video captions to review', ref: `${WCAG}#audio-control` },
  { id: 'semantic/generic-control', authority: 'heuristic', summary: 'div, span, or custom element acting as a button or link', ref: `${ARIA_IN_HTML}#docconformance` },
  { id: 'semantic/link-href', authority: 'heuristic', summary: 'Link without a destination: no href, href="#", or href=""', ref: `${HTML}/links.html#attr-hyperlink-href` },
  { id: 'semantic/native-alternative', authority: 'heuristic', summary: 'ARIA rebuilding a native element, or a text input that wants a specific type', ref: `${ARIA_IN_HTML}#rules-wd` },
  { id: 'semantic/section-heading', authority: 'standard', summary: 'Section without a heading; articles without one are reviewed', ref: `${HTML}/sections.html#the-section-element` },
  { id: 'semantic/heading-candidate', authority: 'heuristic', summary: 'Bold paragraph that may be a heading (review)', ref: `${HTML}/sections.html#headings-and-outlines` },
  { id: 'semantic/list-candidate', authority: 'heuristic', summary: 'Repeated sibling elements that may be a list (review)', ref: `${HTML}/grouping-content.html#the-ul-element` },
  { id: 'semantic/br-spacing', authority: 'heuristic', summary: 'br used for spacing: consecutive, or at the start or end of a block', ref: `${HTML}/text-level-semantics.html#the-br-element` },
  { id: 'semantic/empty-element', authority: 'heuristic', summary: 'Empty p, li, span, or div used as a spacer', ref: `${HTML}/dom.html#palpable-content` },
  { id: 'semantic/fragment-link', authority: 'heuristic', summary: 'Fragment link to an id the page doesn’t have', ref: `${HTML}/browsing-the-web.html#scroll-to-fragid` },
  { id: 'semantic/placeholder-content', authority: 'heuristic', summary: 'Placeholder text, example links, or unresolved template syntax', ref: `${HTML}/dom.html#palpable-content` },
  { id: 'policy/no-div', authority: 'policy', summary: 'div outside dl', ref: HOUSE },
  { id: 'policy/single-h1', authority: 'policy', summary: 'Page without exactly one h1', ref: HOUSE },
  { id: 'policy/button-type', authority: 'policy', summary: 'button without type, which defaults to submit', ref: `${HTML}/form-elements.html#attr-button-type` },
  { id: 'policy/inline-handler', authority: 'policy', summary: 'Inline event handler attribute', ref: `${HTML}/webappapis.html#event-handler-content-attributes` },
  { id: 'policy/javascript-url', authority: 'policy', summary: 'javascript: URL', ref: `${HTML}/browsing-the-web.html#the-javascript:-url-special-case` },
  { id: 'policy/inline-style', authority: 'policy', summary: 'style attribute', ref: HOUSE },
  { id: 'policy/inline-svg', authority: 'policy', summary: 'Inline svg instead of the icon component', ref: HOUSE },
  { id: 'policy/prefer-strong-em', authority: 'policy', summary: 'b or i where strong or em may be meant', ref: `${HTML}/text-level-semantics.html#the-b-element` },
  { id: 'policy/head', authority: 'policy', summary: 'meta charset not first in head, or no viewport meta', ref: HOUSE },
  { id: 'policy/elements', authority: 'policy', summary: 'Element on the configured denylist', ref: HOUSE, options: {
    deny: { type: 'strings', default: ['iframe', 'object', 'embed'], summary: 'element names to reject' },
  } },
  { id: 'policy/class', authority: 'policy', summary: 'Empty class attribute, or a repeated class', ref: HOUSE },
  { id: 'bloat/generic-ratio', authority: 'policy', summary: 'Share of generic elements (div, span, role-less custom elements)', ref: BLOAT, options: {
    max: { type: 'number', default: 0.35, summary: 'largest acceptable share' },
    minElements: { type: 'number', integer: true, default: 20, summary: 'pages smaller than this aren’t measured' },
  } },
  { id: 'bloat/wrapper-chain', authority: 'policy', summary: 'Longest chain of generic wrappers that hold nothing else', ref: BLOAT, options: {
    max: { type: 'number', integer: true, default: 3, summary: 'longest acceptable chain' },
  } },
  { id: 'bloat/class-count', authority: 'policy', summary: 'Most classes on one element, and the 95th percentile', ref: BLOAT, options: {
    max: { type: 'number', integer: true, default: 6, summary: 'most classes on any element' },
    p95: { type: 'number', integer: true, default: 4, summary: 'largest acceptable 95th percentile (pages of 20 elements or more)' },
  } },
  { id: 'bloat/depth', authority: 'policy', summary: 'Deepest element nesting under body', ref: BLOAT, options: {
    max: { type: 'number', integer: true, default: 12, summary: 'deepest acceptable nesting' },
  } },
  { id: 'bloat/size', authority: 'policy', summary: 'Elements per page', ref: BLOAT, options: {
    max: { type: 'number', integer: true, default: 1500, summary: 'most elements per file' },
  } },
];

export const RULE_BY_ID: ReadonlyMap<string, RuleMeta> = new Map(RULES.map((r) => [r.id, r]));
