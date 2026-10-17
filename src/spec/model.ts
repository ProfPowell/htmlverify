// Content models: categories with their conditions, child grammars, descendant
// prohibitions, and contexts (spec §7.1–§7.3). Elements whose content model is
// plain "Phrasing content.", "Flow content.", "Nothing.", "Text.", or
// "Transparent." are derived from the spec data; everything else is written
// out below. data/overlay-basis.json pins the spec text each entry was written
// against, so a spec update that changes it fails a test until it's reviewed.

import { isElement, isHtml, isText, type ChildNode, type Element } from '../parse/tree.ts';
import { HTML, HTML_ELEMENTS, LINK_TYPES, obsoleteElement } from './data.ts';
import { tags, words } from '../text.ts';
import { NS } from './html.ts';

/** Where an element sits: its parent and ancestors within the current scope. */
export interface Env {
  element: Element;
  /** The parent element; for a fragment's top level, the context element; null at a scope root. */
  parent: Element | null;
  /** Ancestor elements, nearest first, ending at the scope root (a fragment's context included). */
  ancestors: readonly Element[];
  /** The child list the element is in. */
  siblings: readonly ChildNode[];
}

export interface Forbid {
  /** What the ancestor must not contain, for messages: "interactive content". */
  what: string;
  test: (element: Element, ancestors: readonly Element[]) => boolean;
}

export interface Variant {
  when?: (env: Env) => boolean;
  content: string;
  /** Script-supporting elements may be intermixed with the children the grammar names. */
  scriptSupporting?: true;
  forbid?: readonly Forbid[];
  /** How messages name the element under this variant: "<colgroup span>". */
  as?: string;
}

export interface ElementModel {
  variants: readonly Variant[];
  forbid?: readonly Forbid[];
  /** Explains the expected structure in order and completeness messages. */
  hint?: string;
  /** Checks placement where a content category doesn't decide it; returns what's wrong, or null. */
  context?: (env: Env) => string | null;
  /** Replaces the incompleteness message: "must contain text". */
  missing?: string;
  /** Element counts among the children: head allows exactly one title. */
  counts?: Readonly<Record<string, readonly [min: number, max: number]>>;
  /** Children aren't checked: raw text, or a separate scope. */
  opaque?: true;
}

// --- Elements -----------------------------------------------------------

/** The HTML local name, or "svg"/"math" for a foreign root; null for other foreign elements. */
export function nameOf(element: Element): string | null {
  if (isHtml(element)) return element.tagName;
  if (element.namespaceURI === NS.svg && element.tagName === 'svg') return 'svg';
  if (element.namespaceURI === NS.mathml && element.tagName === 'math') return 'math';
  return null;
}

const RESERVED_CUSTOM_NAMES = new Set([
  'annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format',
  'font-face-name', 'missing-glyph',
]);

/** Valid custom element name, for names the HTML parser produced (already lowercase, no whitespace). */
export function isCustomElementName(name: string): boolean {
  return /^[a-z][^\sA-Z/>\0]*-[^\sA-Z/>\0]*$/.test(name) && !RESERVED_CUSTOM_NAMES.has(name);
}

export type Kind = 'html' | 'custom' | 'obsolete' | 'unknown' | 'foreign';

export function kindOf(element: Element): Kind {
  if (!isHtml(element)) return 'foreign';
  const name = element.tagName;
  if (HTML_ELEMENTS.has(name) && name !== 'svg' && name !== 'math') return 'html';
  if (isCustomElementName(name)) return 'custom';
  if (obsoleteElement(name) !== null) return 'obsolete';
  return 'unknown';
}

export function attr(element: Element, name: string): string | null {
  return element.attrs.find((a) => a.name === name && !a.namespace)?.value ?? null;
}

export function has(element: Element, name: string): boolean {
  return attr(element, name) !== null;
}

const is = (element: Element | null | undefined, ...names: string[]) =>
  !!element && isHtml(element) && names.includes(element.tagName);

/** The input's type keyword, lowercased; "text" when missing or invalid. */
export function inputType(element: Element): string {
  const type = attr(element, 'type')?.toLowerCase() ?? 'text';
  return HTML.inputTypes.some((t) => t.keyword === type) ? type : 'text';
}

function displaySizeAbove1(select: Element): boolean {
  const size = /^[\t\n\f\r ]*(\d+)/.exec(attr(select, 'size') ?? '');
  return size !== null && Number(size[1]) > 1;
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

export function tokens(value: string | null): string[] {
  return (value ?? '').split(ASCII_WHITESPACE).filter(Boolean);
}

// --- Categories ---------------------------------------------------------

const CATEGORY_NAMES: Record<string, string> = {
  'Flow content': 'flow',
  'Phrasing content': 'phrasing',
  'Heading content': 'heading',
  'Sectioning content': 'sectioning',
  'Metadata content': 'metadata',
  'Interactive content': 'interactive',
  'Embedded content': 'embedded',
  'Palpable content': 'palpable',
  'Script-supporting elements': 'script-supporting',
  'Labelable elements': 'labelable',
  'Listed elements': 'listed',
  'Submittable elements': 'submittable',
  'Resettable elements': 'resettable',
  'Form-associated elements': 'form-associated',
  'Autocapitalize-and-autocorrect inheriting elements': 'autocapitalize-inheriting',
};

type Condition = (element: Element, ancestors: readonly Element[]) => boolean;

/** The conditions in the categories table, keyed by the table's own wording. */
const CONDITIONS: Record<string, Condition> = {
  'if it is a descendant of a map element': (_e, ancestors) => ancestors.some((a) => is(a, 'map')),
  'if it is allowed in the body': (e) => allowedInBody(e),
  'if it is a hierarchically correct main element': (_e, ancestors) => hierarchicallyCorrectMain(ancestors),
  'if the itemprop attribute is present': (e) => has(e, 'itemprop'),
  'if the href attribute is present': (e) => has(e, 'href'),
  'if the controls attribute is present': (e) => has(e, 'controls'),
  'if the usemap or controls attribute is present': (e) => has(e, 'usemap') || has(e, 'controls'),
  'if the type attribute is not in the Hidden state': (e) => inputType(e) !== 'hidden',
  'if the element\'s children include at least one name-value group': (e) => e.childNodes.some((c) => isElement(c) && is(c, 'dt', 'dd', 'div')),
  'if the element\'s children include at least one li element': (e) => e.childNodes.some((c) => isElement(c) && is(c, 'li')),
};

/** Conditions the categories table leaves out, from the element definitions. */
const EXTRA_CONDITIONS: Record<string, Record<string, Condition>> = {
  labelable: { input: (e) => inputType(e) !== 'hidden' },
};

const STATIC = new Map<string, Set<string>>();
const CONDITIONAL = new Map<string, Map<string, Condition>>();
for (const [title, entry] of Object.entries(HTML.categories)) {
  const category = CATEGORY_NAMES[title];
  if (!category) throw new Error(`unknown category "${title}" in the spec data`);
  const conditional = new Map<string, Condition>();
  for (const { element, condition } of entry.conditional) {
    if (!HTML_ELEMENTS.has(element)) continue; // "Text that is not inter-element whitespace"
    const test = CONDITIONS[condition];
    if (!test) throw new Error(`unmodeled category condition "${condition}" (${element}, ${category})`);
    conditional.set(element, test);
  }
  for (const [element, test] of Object.entries(EXTRA_CONDITIONS[category] ?? {})) conditional.set(element, test);
  STATIC.set(category, new Set(entry.elements.filter((e) => !conditional.has(e))));
  CONDITIONAL.set(category, conditional);
}

const CUSTOM_CATEGORIES = new Set(['flow', 'phrasing', 'palpable']);

/** Whether an element (or a text node, for flow and phrasing) is in a content category. */
export function inCategory(element: Element, category: string, ancestors: readonly Element[]): boolean {
  if (kindOf(element) === 'custom') return CUSTOM_CATEGORIES.has(category);
  const name = nameOf(element);
  if (name === null) return false;
  if (STATIC.get(category)?.has(name)) return true;
  const test = CONDITIONAL.get(category)?.get(name);
  return test !== undefined && test(element, ancestors);
}

export function textInCategory(category: string): boolean {
  return category === 'flow' || category === 'phrasing';
}

const BODY_OK = new Set([...LINK_TYPES.values()].filter((l) => l.bodyOk).map((l) => l.keyword));

export function allowedInBody(link: Element): boolean {
  if (has(link, 'itemprop')) return true;
  const rel = tokens(attr(link, 'rel')?.toLowerCase() ?? null);
  return rel.length > 0 && rel.every((r) => BODY_OK.has(r));
}

export const BODY_OK_KEYWORDS: readonly string[] = [...BODY_OK].sort();

/** Ancestors limited to html, body, div, form without an accessible name, and autonomous custom elements. */
export function hierarchicallyCorrectMain(ancestors: readonly Element[]): boolean {
  return ancestors.every((a) =>
    is(a, 'html', 'body', 'div') ||
    (is(a, 'form') && !has(a, 'aria-label') && !has(a, 'aria-labelledby') && !has(a, 'title')) ||
    kindOf(a) === 'custom');
}

// --- Descendant prohibitions ---------------------------------------------

const category = (name: string, what: string): Forbid => ({ what, test: (e, ancestors) => inCategory(e, name, ancestors) });
const elements = (what: string, ...names: string[]): Forbid => ({ what, test: (e) => is(e, ...names) });
const INTERACTIVE = category('interactive', 'interactive content');
const TABINDEX: Forbid = { what: 'elements with tabindex', test: (e) => has(e, 'tabindex') };
const HEADINGS = category('heading', 'heading content');
const SECTIONING = category('sectioning', 'sectioning content');
const HEADER_FOOTER = elements('<header> or <footer> elements', 'header', 'footer');
const MEDIA = elements('media elements (<audio>, <video>)', 'audio', 'video');

const CANVAS_INTERACTIVE: Forbid = {
  what: 'interactive content other than links, buttons, image maps, checkboxes, radio buttons, and list boxes',
  test: (e, ancestors) => {
    if (!inCategory(e, 'interactive', ancestors)) return false;
    if (is(e, 'a', 'button') || (is(e, 'img') && has(e, 'usemap'))) return false;
    if (is(e, 'input') && ['checkbox', 'radio', 'submit', 'image', 'reset', 'button'].includes(inputType(e))) return false;
    if (is(e, 'select') && (has(e, 'multiple') || displaySizeAbove1(e))) return false;
    return true;
  },
};

// --- Contexts -------------------------------------------------------------

const childOf = (...names: string[]) => (env: Env) => (is(env.parent, ...names) ? null : `must be a child of ${tags(names)}`);
const inside = (...names: string[]) => (env: Env) =>
  env.ancestors.some((a) => is(a, ...names)) ? null : `must be inside ${tags(names)}`;
const inHead = (env: Env) => (is(env.parent, 'head') ? null : 'belongs in <head>');

const DL_ITEM = (env: Env) =>
  is(env.parent, 'dl') || (is(env.parent, 'div') && is(env.ancestors[1], 'dl')) ? null : 'must be a child of <dl>, or of a <div> in a <dl>';

const FLOW = '@flow*';
const PHRASING = '@phrasing*';

const HEADING_ELEMENTS = '(h1 | h2 | h3 | h4 | h5 | h6)';

const one = (content: string, extra: Omit<Variant, 'content'> = {}): readonly Variant[] => [{ ...extra, content }];

/** Hand-written models, keyed by element; `variants` omitted means derived from the spec data. */
const OVERLAY: Record<string, Partial<ElementModel>> = {
  a: { variants: one('%transparent'), forbid: [INTERACTIVE, elements('<a> elements', 'a'), TABINDEX] },
  address: { variants: one(FLOW), forbid: [HEADINGS, SECTIONING, elements('<header>, <footer>, or <address> elements', 'header', 'footer', 'address')] },
  area: { context: inside('map') },
  audio: {
    variants: [
      { when: (env) => has(env.element, 'src'), content: 'track* %transparent', as: '<audio src>' },
      { content: 'source* track* %transparent' },
    ],
    forbid: [MEDIA],
    hint: 'Media elements hold <source> elements (unless they have src), then <track> elements, then fallback content.',
  },
  base: { context: inHead },
  button: { variants: one(PHRASING), forbid: [INTERACTIVE, TABINDEX] },
  canvas: { variants: one('%transparent'), forbid: [CANVAS_INTERACTIVE] },
  caption: { variants: one(FLOW), forbid: [elements('<table> elements', 'table')], context: childOf('table') },
  col: { context: childOf('colgroup') },
  colgroup: {
    variants: [
      { when: (env) => has(env.element, 'span'), content: 'empty', as: '<colgroup span>' },
      { content: '(col | template)*' },
    ],
    context: childOf('table'),
  },
  datalist: { variants: one(`${PHRASING} | (option | @script-supporting)*`), hint: '<datalist> holds <option> elements, or phrasing content.' },
  dd: { context: DL_ITEM },
  details: { variants: one(`summary ${FLOW}`), hint: '<details> starts with a <summary>, followed by flow content.' },
  dfn: { variants: one(PHRASING), forbid: [elements('<dfn> elements', 'dfn')] },
  div: {
    variants: [
      { when: (env) => is(env.parent, 'dl'), content: 'dt+ dd+', scriptSupporting: true, as: '<div> in <dl>' },
      { when: (env) => env.ancestors.some((a) => is(a, 'option', 'optgroup', 'select')), content: '%transparent' },
      { content: FLOW },
    ],
    hint: 'A <div> in a <dl> holds one or more <dt> followed by one or more <dd>.',
  },
  dl: {
    variants: one('(dt+ dd+)* | div+', { scriptSupporting: true }),
    hint: '<dl> holds groups of <dt> followed by <dd>, or <div> elements that each hold one such group.',
  },
  dt: { variants: one(FLOW), forbid: [HEADER_FOOTER, SECTIONING, HEADINGS], context: DL_ITEM },
  fieldset: { variants: one(`legend? ${FLOW}`), hint: 'A <legend> can only be the first child of <fieldset>.' },
  figcaption: { context: childOf('figure') },
  figure: { variants: one(`figcaption ${FLOW} | ${FLOW} figcaption?`), hint: 'A <figcaption> can only be the first or last child of <figure>.' },
  footer: { variants: one(FLOW), forbid: [HEADER_FOOTER] },
  form: { variants: one(FLOW), forbid: [elements('<form> elements', 'form')] },
  head: {
    variants: one('@metadata*'),
    counts: { title: [1, 1], base: [0, 1] },
    hint: '<head> holds metadata content, with exactly one <title> and at most one <base>.',
  },
  header: { variants: one(FLOW), forbid: [HEADER_FOOTER] },
  hgroup: {
    variants: one(`p* ${HEADING_ELEMENTS} p*`, { scriptSupporting: true }),
    hint: '<hgroup> holds one heading (<h1>–<h6>), with optional <p> elements before and after it.',
  },
  html: { variants: one('head body') },
  label: { variants: one(PHRASING), forbid: [elements('<label> elements', 'label')] },
  legend: {
    variants: [
      { when: (env) => is(env.parent, 'optgroup'), content: PHRASING, forbid: [INTERACTIVE, TABINDEX], as: '<legend> in <optgroup>' },
      { content: '(@phrasing | @heading)*' },
    ],
    context: childOf('fieldset', 'optgroup'),
  },
  li: { context: childOf('ul', 'ol', 'menu') },
  link: {
    context: (env) =>
      is(env.parent, 'head') || allowedInBody(env.element)
        ? null
        : `belongs in <head>: in the body, a <link> needs itemprop, or a rel of only ${words(BODY_OK_KEYWORDS)}`,
  },
  main: {
    context: (env) =>
      hierarchicallyCorrectMain(env.ancestors)
        ? null
        : 'can only have <html>, <body>, <div>, unnamed <form>, and custom elements as ancestors',
  },
  menu: { variants: one('li*', { scriptSupporting: true }) },
  meta: { context: (env) => (has(env.element, 'itemprop') ? null : inHead(env)) },
  meter: { variants: one(PHRASING), forbid: [elements('<meter> elements', 'meter')] },
  noscript: { opaque: true },
  ol: { variants: one('li*', { scriptSupporting: true }) },
  optgroup: {
    variants: one('legend? (option | @script-supporting | noscript | div)*'),
    context: inside('select'),
    hint: '<optgroup> holds an optional <legend> first, then <option> and <div> elements.',
  },
  option: {
    variants: [
      { when: (env) => has(env.element, 'label') && has(env.element, 'value'), content: 'empty', as: '<option label value>' },
      { when: (env) => has(env.element, 'label'), content: 'text', as: '<option label>' },
      { when: (env) => env.ancestors.some((a) => is(a, 'datalist')), content: 'text', as: '<option> in <datalist>' },
      {
        content: `(div | @phrasing)*`,
        forbid: [INTERACTIVE, elements('<datalist> elements', 'datalist'), elements('<object> elements', 'object'), TABINDEX],
      },
    ],
    context: inside('select', 'datalist', 'optgroup'),
  },
  picture: { variants: one('source* img', { scriptSupporting: true }), hint: '<picture> holds <source> elements followed by one <img>.' },
  progress: { variants: one(PHRASING), forbid: [elements('<progress> elements', 'progress')] },
  rp: { context: childOf('ruby') },
  rt: { context: childOf('ruby') },
  // Approximates the ruby prose: rt and rp mixed with phrasing content.
  ruby: { variants: one('(@phrasing | rt | rp)*') },
  script: { variants: one('text') },
  select: {
    variants: [
      { when: (env) => has(env.element, 'multiple') || displaySizeAbove1(env.element), content: '(option | optgroup | hr | @script-supporting | noscript | div)*', as: '<select> list box' },
      { content: 'button? (option | optgroup | hr | @script-supporting | noscript | div)*' },
    ],
    hint: '<select> holds an optional <button> first, then <option>, <optgroup>, <hr>, and <div> elements.',
  },
  selectedcontent: {
    context: (env) => {
      const button = env.ancestors.find((a) => is(a, 'button'));
      const select = button && env.ancestors[env.ancestors.indexOf(button) + 1];
      return is(select, 'select') ? null : 'must be inside the <button> that starts a <select>';
    },
  },
  source: { context: childOf('picture', 'audio', 'video') },
  style: {
    variants: one('text'),
    context: (env) => {
      if (is(env.parent, 'head') || env.parent === null) return null;
      const first = env.siblings.find((c) => isElement(c) || (isText(c) && !/^[\t\n\f\r ]*$/.test(c.value)));
      return first === env.element ? null : 'must be in <head>, or be the first child of its parent';
    },
  },
  summary: { variants: one('(@phrasing | @heading)*'), context: childOf('details') },
  table: {
    variants: one('caption? colgroup* thead? (tbody* | tr+) tfoot?', { scriptSupporting: true }),
    hint: 'Table parts go in this order: <caption>, <colgroup>, <thead>, then <tbody> or <tr> elements, then <tfoot>.',
  },
  tbody: { variants: one('tr*', { scriptSupporting: true }), context: childOf('table') },
  td: { context: childOf('tr') },
  template: { opaque: true },
  tfoot: { variants: one('tr*', { scriptSupporting: true }), context: childOf('table') },
  th: { variants: one(FLOW), forbid: [HEADER_FOOTER, SECTIONING, HEADINGS], context: childOf('tr') },
  thead: { variants: one('tr*', { scriptSupporting: true }), context: childOf('table') },
  time: {
    variants: [
      { when: (env) => has(env.element, 'datetime'), content: PHRASING },
      { content: 'text', as: '<time> without datetime' },
    ],
  },
  title: { variants: one('#text'), missing: 'must contain text', context: inHead },
  tr: { variants: one('(td | th)*', { scriptSupporting: true }), context: childOf('thead', 'tbody', 'tfoot', 'table') },
  track: { context: childOf('audio', 'video') },
  ul: { variants: one('li*', { scriptSupporting: true }) },
  video: {
    variants: [
      { when: (env) => has(env.element, 'src'), content: 'track* %transparent', as: '<video src>' },
      { content: 'source* track* %transparent' },
    ],
    forbid: [MEDIA],
    hint: 'Media elements hold <source> elements (unless they have src), then <track> elements, then fallback content.',
  },
};

const DERIVED: Record<string, string> = {
  'Phrasing content.': PHRASING,
  'Flow content.': FLOW,
  'Nothing.': 'empty',
  'Text.': 'text',
  'Transparent.': '%transparent',
  'Transparent': '%transparent',
};

const MODELS = new Map<string, ElementModel>();
for (const [name, definition] of Object.entries(HTML.definitions)) {
  const overlay = OVERLAY[name] ?? {};
  const derived = definition.contentModel.length === 1 ? DERIVED[definition.contentModel[0]!] : undefined;
  if (!overlay.variants && !overlay.opaque && derived === undefined) {
    throw new Error(`no content model for <${name}>: "${definition.contentModel.join(' ')}"`);
  }
  MODELS.set(name, { variants: overlay.variants ?? one(derived ?? 'empty'), ...overlay } as ElementModel);
}
for (const name of Object.keys(OVERLAY)) if (!MODELS.has(name)) throw new Error(`overlay for unknown element <${name}>`);

/** The model for an HTML element, or the autonomous custom element model (transparent). */
export function modelOf(element: Element): ElementModel | null {
  const kind = kindOf(element);
  if (kind === 'custom') return CUSTOM;
  if (kind !== 'html') return null;
  return MODELS.get(element.tagName) ?? null;
}

const CUSTOM: ElementModel = { variants: one('%transparent') };

export function variantOf(model: ElementModel, env: Env): Variant {
  return model.variants.find((v) => !v.when || v.when(env)) ?? model.variants.at(-1)!;
}

/** The elements written out by hand, for the overlay-basis test. */
export const OVERLAY_ELEMENTS: readonly string[] = Object.keys(OVERLAY).sort();
