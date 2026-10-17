// ARIA in HTML: each element's implicit role and the roles and aria-*
// attributes authors may give it. data/html-aria.json carries the table and
// its regular rows, parsed by tools/extract/html-aria.ts; the conditional rows
// are encoded here. data/html-aria-basis.json pins the text of every row.

import raw from '../../data/html-aria.json' with { type: 'json' };
import { isElement, isHtml, type Element } from '../parse/tree.ts';
import { NS } from './html.ts';
import { attr, has, inputType, kindOf, tokens } from './model.ts';

export type AriaPolicy = 'none' | 'hidden-only' | 'global' | 'roles' | { role: string } | { extra: string[] };

interface ParsedRow {
  conditional: boolean;
  implicit: string | null;
  /** ["*"] for any role. */
  allowed: string[];
  discouraged: string[];
  aria: AriaPolicy;
  namingProhibited: boolean;
  mustNot: string[];
  shouldNot: string[];
}

export interface HtmlAriaData {
  source: { repo: string; commit: string; date: string; file: string; sha256: string };
  rows: Record<string, { element: string; implicit: string; allowances: string; roles: string[]; dpubRoles: string[]; parsed: ParsedRow }>;
}

export const HTML_ARIA: HtmlAriaData = raw as HtmlAriaData;

export interface Semantics {
  /** The ARIA in HTML row, such as "el-a". */
  row: string;
  implicit: string | null;
  /** Roles authors may set, or "any". */
  allowed: 'any' | ReadonlySet<string>;
  /** Allowed roles that are NOT RECOMMENDED or SHOULD NOT be used: usually the implicit role, or generic. */
  discouraged: ReadonlySet<string>;
  aria: AriaPolicy;
  namingProhibited: boolean;
  mustNot: readonly string[];
  shouldNot: readonly string[];
}

/** DPub and Graphics roles the tables mention; they're checked only for being known. */
export const EXTENSION_ROLES: ReadonlySet<string> = new Set([
  ...Object.values(HTML_ARIA.rows).flatMap((r) => r.dpubRoles),
  'graphics-document', 'graphics-object', 'graphics-symbol',
]);

function fromRow(id: string, overrides: Partial<Semantics> = {}): Semantics {
  const row = HTML_ARIA.rows[id];
  if (!row) throw new Error(`no ARIA in HTML row ${id}`);
  const p = row.parsed;
  const allowed = p.allowed.includes('*') ? 'any' : new Set([...p.allowed, ...row.dpubRoles]);
  return {
    row: id,
    implicit: p.implicit,
    allowed,
    discouraged: new Set(p.discouraged),
    aria: p.aria,
    namingProhibited: p.namingProhibited,
    mustNot: p.mustNot,
    shouldNot: p.shouldNot,
    ...overrides,
  };
}

const ANY = 'any' as const;
const set = (...roles: string[]) => new Set(roles);
const is = (e: Element | null | undefined, ...names: string[]) => !!e && isHtml(e) && names.includes(e.tagName);
const parentElement = (e: Element) => (e.parentNode && isElement(e.parentNode) ? e.parentNode : null);

/** The first role token, as browsers read the role attribute's fallback list. */
export function explicitRole(element: Element): string | null {
  return tokens(attr(element, 'role')?.toLowerCase() ?? null)[0] ?? null;
}

function hasAuthorName(element: Element): boolean {
  return !!attr(element, 'aria-label')?.trim() || has(element, 'aria-labelledby') || !!attr(element, 'title')?.trim();
}

/** Sectioning content and the landmark roles that scope header and footer. */
function scoped(ancestors: readonly Element[]): boolean {
  return ancestors.some((a) =>
    is(a, 'article', 'aside', 'main', 'nav', 'section') ||
    ['article', 'complementary', 'main', 'navigation', 'region'].includes(explicitRole(a) ?? ''));
}

/** How the nearest table exposes itself: table, grid, or neither. */
function tableKind(ancestors: readonly Element[]): 'table' | 'grid' | null {
  const table = ancestors.find((a) => is(a, 'table'));
  if (!table) return null;
  const role = explicitRole(table);
  if (role === null || role === 'table') return 'table';
  if (role === 'grid' || role === 'treegrid') return 'grid';
  return null;
}

const INPUT_ROWS: Record<string, string> = {
  button: 'el-input-button', checkbox: 'el-input-checkbox', color: 'el-input-color', date: 'el-input-date',
  'datetime-local': 'el-input-datetime-local', email: 'el-input-email', file: 'el-input-file', hidden: 'el-input-hidden',
  image: 'el-input-image', month: 'el-input-month', number: 'el-input-number', password: 'el-input-password',
  radio: 'el-input-radio', range: 'el-input-range', reset: 'el-input-reset', search: 'el-input-search',
  submit: 'el-input-submit', tel: 'el-input-tel', text: 'el-input-text', time: 'el-input-time', url: 'el-input-url',
  week: 'el-input-week',
};
const LIST_TYPES = new Set(['text', 'search', 'tel', 'url', 'email']);

/**
 * The ARIA in HTML semantics of an element. `ancestors` are its ancestors,
 * nearest first; null for elements the tables don't cover.
 */
export function semanticsOf(element: Element, ancestors: readonly Element[]): Semantics | null {
  if (element.namespaceURI === NS.svg && element.tagName === 'svg') return fromRow('el-svg');
  if (element.namespaceURI === NS.mathml && element.tagName === 'math') return fromRow('el-math');
  const kind = kindOf(element);
  if (kind === 'custom') {
    return fromRow('el-autonomous-custom-element', { implicit: 'generic', allowed: ANY, discouraged: set('generic'), namingProhibited: !explicitRole(element) });
  }
  if (kind !== 'html') return null;
  const tag = element.tagName;
  const parent = ancestors[0] ?? parentElement(element);
  switch (tag) {
    case 'a':
    case 'area':
      return fromRow(has(element, 'href') ? `el-${tag}` : `el-${tag}-no-href`);
    case 'button':
      // A select's first-child button is inert.
      if (is(parent, 'select') && parent?.childNodes.find(isElement) === element) {
        return fromRow('el-button', { allowed: set(), discouraged: set(), aria: 'none' });
      }
      return fromRow('el-button', { aria: 'roles' });
    case 'div':
      if (is(parent, 'dl')) return fromRow('el-div', { allowed: set('presentation', 'none') });
      return fromRow('el-div', { allowed: ANY, discouraged: set('generic'), namingProhibited: !explicitRole(element) });
    case 'figure': {
      const captioned = element.childNodes.some((c) => isElement(c) && is(c, 'figcaption'));
      return captioned
        ? fromRow('el-figure', { allowed: set('figure', 'doc-example'), discouraged: set('figure') })
        : fromRow('el-figure', { allowed: ANY, discouraged: set('figure') });
    }
    case 'footer':
    case 'header': {
      const landmark = tag === 'header' ? 'banner' : 'contentinfo';
      const top = !scoped(ancestors);
      const roles = HTML_ARIA.rows[`el-${tag}`]!.parsed.allowed.filter((r) => r !== landmark && r !== 'generic');
      return fromRow(`el-${tag}`, {
        implicit: top ? landmark : 'generic',
        allowed: set(...roles, top ? landmark : 'generic', ...HTML_ARIA.rows[`el-${tag}`]!.dpubRoles),
        discouraged: set(top ? landmark : 'generic'),
        namingProhibited: !top && !explicitRole(element),
      });
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return fromRow('el-h1-h6');
    case 'img': {
      const alt = attr(element, 'alt');
      if (alt === '' && !hasAuthorName(element)) return fromRow('el-img-no-name', { implicit: 'none', allowed: set('none', 'presentation'), discouraged: set('none', 'presentation') });
      const named = (alt !== null && alt !== '') || hasAuthorName(element);
      return named
        ? fromRow('el-img', { implicit: 'image' })
        : fromRow('el-img', { implicit: 'image', allowed: set('none', 'presentation', 'img', 'image'), discouraged: set('img', 'image') });
    }
    case 'input': {
      const type = inputType(element);
      if (LIST_TYPES.has(type) && has(element, 'list')) return fromRow('el-input-text-list');
      return fromRow(INPUT_ROWS[type] ?? 'el-input-text');
    }
    case 'label': {
      const labels = has(element, 'for') || element.childNodes.some(function labelable(c): boolean {
        return isElement(c) && (is(c, 'button', 'meter', 'output', 'progress', 'select', 'textarea') || (is(c, 'input') && inputType(c) !== 'hidden') || c.childNodes.some(labelable));
      });
      return labels
        ? fromRow('el-label', { allowed: set(), discouraged: set() })
        : fromRow('el-label', { allowed: ANY, discouraged: set('generic'), namingProhibited: !explicitRole(element) });
    }
    case 'li': {
      const listParent = parent && (['list', 'directory'].includes(explicitRole(parent) ?? '') || (explicitRole(parent) === null && is(parent, 'ul', 'ol', 'menu')));
      return listParent
        ? fromRow('el-li', { implicit: 'listitem', allowed: set('listitem'), discouraged: set('listitem') })
        : fromRow('el-li', { implicit: 'generic', allowed: ANY, discouraged: set('generic') });
    }
    case 'section':
      return fromRow('el-section', { implicit: hasAuthorName(element) ? 'region' : 'generic' });
    case 'select':
      return fromRow(has(element, 'multiple') || Number(/^\s*(\d+)/.exec(attr(element, 'size') ?? '')?.[1] ?? 0) > 1 ? 'el-select-multiple-or-size-greater-1' : 'el-select');
    case 'selectedcontent':
      return ancestors.some((a) => is(a, 'select'))
        ? fromRow('el-selectedcontent', { allowed: set(), discouraged: set(), aria: 'none' })
        : fromRow('el-selectedcontent', { allowed: ANY, discouraged: set('generic') });
    case 'summary': {
      const details = is(parent, 'details') && parent!.childNodes.find((c) => isElement(c) && is(c, 'summary')) === element;
      return details
        ? fromRow('el-summary', { allowed: set(), discouraged: set(), aria: { extra: ['aria-disabled', 'aria-haspopup'] } })
        : fromRow('el-summary', { allowed: ANY, discouraged: set() });
    }
    case 'td':
    case 'th':
    case 'tr': {
      const table = tableKind(ancestors);
      if (table === null) return fromRow(`el-${tag}`, { implicit: null, allowed: ANY, discouraged: set(tag === 'tr' ? 'row' : '') });
      if (tag === 'tr') return fromRow('el-tr', { implicit: 'row', allowed: set('row'), discouraged: set('row') });
      const cell = table === 'grid' ? 'gridcell' : 'cell';
      if (tag === 'td') return fromRow('el-td', { implicit: cell, allowed: set(cell), discouraged: set(cell) });
      const scope = attr(element, 'scope')?.toLowerCase();
      const header = scope === 'row' || scope === 'rowgroup' ? 'rowheader' : 'columnheader';
      return fromRow('el-th', { implicit: header, allowed: set('columnheader', 'rowheader', cell), discouraged: set('columnheader', 'rowheader', cell) });
    }
  }
  return HTML_ARIA.rows[`el-${tag}`] ? fromRow(`el-${tag}`) : null;
}

/** The rows encoded by hand, for the basis test. */
export const CONDITIONAL_ROWS: readonly string[] = Object.entries(HTML_ARIA.rows).filter(([, r]) => r.parsed.conditional).map(([id]) => id);
