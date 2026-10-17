// Hand-written M0 subset of WHATWG HTML data. M1 replaces it with tables
// generated from a pinned spec snapshot (spec §3.4).

export const NS = {
  html: 'http://www.w3.org/1999/xhtml',
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
} as const;

// https://html.spec.whatwg.org/multipage/syntax.html#void-elements
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

// Boolean attributes from the attribute index:
// https://html.spec.whatwg.org/multipage/indices.html#attributes-3
const GLOBAL_BOOLEANS = ['autofocus', 'inert', 'itemscope'];
const ELEMENT_BOOLEANS: Record<string, string[]> = {
  audio: ['autoplay', 'controls', 'disableremoteplayback', 'loop', 'muted'],
  button: ['disabled', 'formnovalidate'],
  details: ['open'],
  dialog: ['open'],
  fieldset: ['disabled'],
  form: ['novalidate'],
  iframe: ['allowfullscreen'],
  img: ['ismap'],
  input: ['alpha', 'checked', 'disabled', 'formnovalidate', 'multiple', 'readonly', 'required'],
  link: ['disabled'],
  ol: ['reversed'],
  optgroup: ['disabled'],
  option: ['disabled', 'selected'],
  script: ['async', 'defer', 'nomodule'],
  select: ['disabled', 'multiple', 'required'],
  template: ['shadowrootclonable', 'shadowrootdelegatesfocus', 'shadowrootserializable'],
  textarea: ['disabled', 'readonly', 'required'],
  track: ['default'],
  video: ['autoplay', 'controls', 'disablepictureinpicture', 'disableremoteplayback', 'loop', 'muted', 'playsinline'],
};

export function isBooleanAttribute(element: string, attribute: string): boolean {
  return GLOBAL_BOOLEANS.includes(attribute) || (ELEMENT_BOOLEANS[element]?.includes(attribute) ?? false);
}

// Elements whose start tag may be omitted. The conditions in §13.1.2.4 are not
// evaluated: strict requires every start tag, so an implied one is always reported.
export const OPTIONAL_START_TAGS: ReadonlySet<string> = new Set(['html', 'head', 'body', 'tbody', 'colgroup']);

// Elements that close an open `p` when they start (§13.1.2.4, "A p element's end tag may be omitted if…").
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu',
  'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul',
]);

// Parents in which a `p` that is the last child still needs its end tag.
const P_KEEP_END_IN = new Set(['a', 'audio', 'del', 'ins', 'map', 'noscript', 'video']);

/** What follows an element whose end tag was omitted, for the optional-tag rules. */
export interface Following {
  /** Local name of the next sibling element, or null when the next sibling is not an element. */
  nextElement: string | null;
  /** True when the next sibling is a comment, or whitespace-only text. */
  nextIsCommentOrSpace: boolean;
  nextIsComment: boolean;
  /** True when the element is its parent's last child. */
  last: boolean;
  /** Local name of the parent when it is an HTML element. */
  parent: string | null;
}

/**
 * Whether HTML allows this element's end tag to be omitted, per the optional-tag
 * rules in §13.1.2.4: https://html.spec.whatwg.org/multipage/syntax.html#optional-tags
 */
export function endTagMayBeOmitted(tag: string, f: Following): boolean {
  const next = f.nextElement;
  switch (tag) {
    case 'html':
    case 'body':
      return !f.nextIsComment;
    case 'head':
    case 'colgroup':
    case 'caption':
      return !f.nextIsCommentOrSpace;
    case 'li':
      return next === 'li' || f.last;
    case 'dt':
      return next === 'dt' || next === 'dd';
    case 'dd':
      return next === 'dd' || next === 'dt' || f.last;
    case 'p':
      if (next !== null && P_CLOSERS.has(next)) return true;
      return f.last && f.parent !== null && !P_KEEP_END_IN.has(f.parent) && !f.parent.includes('-');
    case 'rt':
    case 'rp':
      return next === 'rt' || next === 'rp' || f.last;
    case 'optgroup':
      return next === 'optgroup' || next === 'hr' || f.last;
    case 'option':
      return next === 'option' || next === 'optgroup' || next === 'hr' || f.last;
    case 'thead':
      return next === 'tbody' || next === 'tfoot';
    case 'tbody':
      return next === 'tbody' || next === 'tfoot' || f.last;
    case 'tfoot':
      return f.last;
    case 'tr':
      return next === 'tr' || f.last;
    case 'td':
    case 'th':
      return next === 'td' || next === 'th' || f.last;
    default:
      return false;
  }
}
