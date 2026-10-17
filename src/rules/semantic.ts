import { indexIds, resolveId } from '../analysis/ids.ts';
import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, walk, type ChildNode, type Element } from '../parse/tree.ts';
import { explicitRole } from '../spec/html-aria.ts';
import { attr, has, inputType, kindOf } from '../spec/model.ts';
import { closest } from '../text.ts';
import type { RawFinding, RawReview, RuleContext } from './types.ts';
import { readAttribute, spanOf } from './util.ts';

export interface SemanticResult {
  findings: RawFinding[];
  reviews: RawReview[];
}

const is = (e: Element | null | undefined, ...names: string[]) => !!e && isHtml(e) && names.includes(e.tagName);

/** Roles that native elements already provide, and the element to use instead. */
const NATIVE: Record<string, string> = {
  dialog: '<dialog>', alertdialog: '<dialog>', progressbar: '<progress>', meter: '<meter>', search: '<search>',
  navigation: '<nav>', main: '<main>', banner: '<header>', contentinfo: '<footer>', complementary: '<aside>',
  article: '<article>', list: '<ul> or <ol>', listitem: '<li>', table: '<table>', heading: '<h1>–<h6>',
  checkbox: '<input type="checkbox">', radio: '<input type="radio">', textbox: '<input> or <textarea>',
  separator: '<hr>', figure: '<figure>', slider: '<input type="range">',
  spinbutton: '<input type="number">', option: '<option>', paragraph: '<p>', blockquote: '<blockquote>',
  form: '<form>', code: '<code>', strong: '<strong>', emphasis: '<em>', time: '<time>',
};

/** Elements that natively carry each role, which the alternative check skips. */
const CARRIES: Record<string, string[]> = {
  dialog: ['dialog'], alertdialog: ['dialog'], progressbar: ['progress'], meter: ['meter'], search: ['search', 'form'],
  navigation: ['nav'], main: ['main'], banner: ['header'], contentinfo: ['footer'], complementary: ['aside'],
  article: ['article'], list: ['ul', 'ol', 'menu'], listitem: ['li'], table: ['table'], heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  checkbox: ['input'], radio: ['input'], textbox: ['input', 'textarea'], img: ['img', 'svg'], image: ['img', 'svg'], separator: ['hr'],
  figure: ['figure'], slider: ['input'], spinbutton: ['input'], option: ['option'], paragraph: ['p'], blockquote: ['blockquote'],
  form: ['form'], code: ['code'], strong: ['strong'], emphasis: ['em'], time: ['time'],
};

const BLOCKS = new Set(['p', 'div', 'li', 'td', 'th', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption', 'caption', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'address', 'summary', 'legend']);
const NOT_LIST_CANDIDATES = new Set(['li', 'tr', 'td', 'th', 'dt', 'dd', 'option', 'optgroup', 'col', 'source', 'track', 'meta', 'link', 'br', 'wbr', 'hr', 'script', 'style', 'template', 'input', 'label']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup']);
const SECTIONING = new Set(['article', 'aside', 'nav', 'section']);

const PLACEHOLDERS: { pattern: RegExp; what: string }[] = [
  { pattern: /\blorem ipsum\b/i, what: 'lorem ipsum filler' },
  { pattern: /\b(?:TODO|FIXME|TBD|XXX)\b/, what: 'a TODO marker' },
  { pattern: /\[(?:your|insert|add|enter|company|name|title|date)\b[^\]]*\]/i, what: 'a bracketed placeholder' },
  { pattern: /\{\{[^}]*\}\}/, what: 'an unresolved {{…}} template expression' },
  { pattern: /\{%[^%]*%\}/, what: 'an unresolved {%…%} template tag' },
  { pattern: /<%[^%]*%>/, what: 'an unresolved <%…%> template tag' },
  { pattern: /\$\{[^}]*\}/, what: 'an unresolved ${…} expression' },
];
const EXAMPLE_HOST = /^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/@]*@)?(?:www\.)?example\.(?:com|org|net)(?:[:/?#]|$)/i;

/** The semantic rules (spec §6.6): native features over rebuilt ones, and likely structure. */
export function checkSemantic(ctx: RuleContext): SemanticResult {
  const findings: RawFinding[] = [];
  const reviews: RawReview[] = [];
  const document = ctx.parsed.kind === 'document';
  const ids = indexIds(ctx.parsed.root, ctx.parsed.kind);
  const elements: Element[] = [];
  const inTemplate = new Set<Element>();
  for (const { node, parent } of walk(ctx.parsed.root)) {
    if (!isElement(node)) continue;
    if (parent && isElement(parent) && (inTemplate.has(parent) || is(parent, 'template'))) inTemplate.add(node);
    if (node.sourceCodeLocation?.startTag) elements.push(node);
  }
  const span = (e: Element) => spanOf(e, ctx.text);
  const attrSpan = (e: Element, name: string) => {
    const loc = e.sourceCodeLocation?.attrs?.[name];
    return loc ? { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset } : span(e);
  };
  const report = (rule: string, where: { offset: number; endOffset: number }, message: string, extra: Partial<RawFinding> = {}) =>
    findings.push({ rule, ...where, message, ...extra });
  const significant = (nodes: readonly ChildNode[]) => nodes.filter((n) => !isComment(n) && !isWhitespaceText(n));

  for (const e of elements) {
    const role = explicitRole(e);
    const tag = isHtml(e) ? e.tagName : null;

    // semantic/generic-control
    if (is(e, 'div', 'span') || kindOf(e) === 'custom') {
      // Other roles are semantic/native-alternative's to judge.
      const control = role === 'button' || role === 'link' || (role === null && (has(e, 'onclick') || attr(e, 'tabindex')?.trim() === '0'));
      if (control && !(kindOf(e) === 'custom' && !role && !has(e, 'onclick'))) {
        const instead = role === 'link' ? '<a href>' : '<button type="button">';
        const how = role ? `role="${role}"` : has(e, 'onclick') ? 'onclick' : 'tabindex="0"';
        // Focusable without a role is a11y/tabindex's defect too.
        const focusOnly = how === 'tabindex="0"';
        report('semantic/generic-control', focusOnly ? attrSpan(e, 'tabindex') : span(e), `<${e.tagName}> with ${how} acts as a control; use ${instead}, which is focusable and keyboard-operable on its own.`, focusOnly ? { defect: 'focusable-without-role' } : {});
      }
    }

    // semantic/link-href
    if (is(e, 'a')) {
      const href = attr(e, 'href');
      if (href === null) {
        if (!has(e, 'name') && !has(e, 'id')) report('semantic/link-href', span(e), '<a> without href isn’t a link: give it href, or use <button type="button"> for an action.');
      } else if (href.trim() === '' || href.trim() === '#') {
        report('semantic/link-href', attrSpan(e, 'href'), `href="${href}" goes nowhere: link to a real URL, or use <button type="button"> for an action.`);
      }
    }

    // semantic/native-alternative
    if (role && NATIVE[role] && !(tag && CARRIES[role]?.includes(tag)) && !(e.tagName === 'svg')) {
      report('semantic/native-alternative', attrSpan(e, 'role'), `role="${role}" rebuilds a native element; use ${NATIVE[role]}, which comes with its behavior.`);
    }
    if (has(e, 'aria-expanded') && !has(e, 'aria-haspopup') && (is(e, 'button') || role === 'button')) {
      const target = attr(e, 'aria-controls');
      const controlled = target ? resolveId(ids, e, target.split(/\s+/)[0]!) : null;
      const popup = controlled && ['menu', 'listbox', 'tree', 'grid', 'dialog', 'menubar'].includes(explicitRole(controlled) ?? '');
      if (controlled && !popup && !is(controlled, 'dialog', 'select', 'ul', 'ol', 'menu', 'nav')) {
        report('semantic/native-alternative', span(e), 'This aria-expanded button toggles a region; <details> and <summary> do that natively, keyboard and state included.');
      }
    }
    if (is(e, 'input') && inputType(e) === 'text' && (attr(e, 'type') ?? 'text').toLowerCase() === 'text') {
      const hint = `${attr(e, 'name') ?? ''} ${attr(e, 'id') ?? ''} ${attr(e, 'autocomplete') ?? ''}`.toLowerCase();
      const better = /e-?mail/.test(hint) ? 'email' : /\b(?:phone|tel|mobile)\b|phone|telephone/.test(hint) ? 'tel' : /\b(?:url|website|homepage)\b/.test(hint) ? 'url' : null;
      if (better) report('semantic/native-alternative', span(e), `This input collects ${better === 'tel' ? 'a phone number' : better === 'url' ? 'a URL' : 'an email address'}; use type="${better}" for the right keyboard and validation.`);
    }

    // semantic/section-heading
    if (is(e, 'section', 'article') && !inTemplate.has(e)) {
      const heading = hasOwnHeading(e);
      if (!heading && is(e, 'section') && !has(e, 'aria-label') && !has(e, 'aria-labelledby')) {
        report('semantic/section-heading', span(e), '<section> has no heading; give it one (h2–h6), or name it with aria-labelledby. A <section> that is only a styling hook isn’t a section; use data-layout on its parent instead.');
      } else if (!heading && is(e, 'article')) {
        reviews.push({ rule: 'semantic/section-heading', ...span(e), ask: 'This <article> has no heading; would one help readers and screen reader users find it?' });
      }
    }

    // semantic/heading-candidate
    if (is(e, 'p')) {
      const kids = significant(e.childNodes);
      const only = kids.length === 1 && isElement(kids[0]!) && is(kids[0] as Element, 'strong', 'b') ? (kids[0] as Element) : null;
      const next = only ? nextSignificant(e) : null;
      if (only && next && (isText(next) || is(next as Element, 'p', 'ul', 'ol'))) {
        reviews.push({ rule: 'semantic/heading-candidate', ...span(e), ask: `Is "${textOf(only).slice(0, 40)}" a heading? If it introduces the text after it, use <h2>–<h6>.` });
      }
    }

    // semantic/br-spacing
    if (is(e, 'br')) {
      const previous = previousSignificant(e);
      if (previous && isElement(previous) && is(previous, 'br') && !(previousSignificant(previous) && is(previousSignificant(previous) as Element, 'br'))) {
        report('semantic/br-spacing', span(previous), 'Consecutive <br> elements make vertical space; use separate paragraphs or CSS margins.');
      }
      const parent = e.parentNode && isElement(e.parentNode) ? e.parentNode : null;
      if (parent && isHtml(parent) && BLOCKS.has(parent.tagName)) {
        const kids = significant(parent.childNodes);
        if (kids.length === 1) {
          report('semantic/br-spacing', span(e), `A <${parent.tagName}> that holds only <br> is an empty line; remove it, and use CSS for spacing.`);
        } else if (kids[0] === e || kids.at(-1) === e) {
          report('semantic/br-spacing', span(e), `A <br> at the ${kids[0] === e ? 'start' : 'end'} of <${parent.tagName}> only adds an empty line; remove it, and use CSS for spacing.`);
        }
      }
    }

    // semantic/empty-element
    if (is(e, 'p', 'li', 'span', 'div') && significant(e.childNodes).length === 0 && e.attrs.every((a) => a.name === 'class')) {
      report('semantic/empty-element', span(e), `Empty <${e.tagName}>; remove it, and use CSS for spacing.`);
    }

    // semantic/fragment-link
    if (document && is(e, 'a', 'area') && !inTemplate.has(e)) {
      const href = attr(e, 'href')?.trim();
      if (href && href.startsWith('#') && href.length > 1 && href.toLowerCase() !== '#top') {
        const id = decodeFragment(href.slice(1));
        const top = ids.scopes[0]!;
        const named = elements.some((x) => is(x, 'a') && attr(x, 'name') === id && !inTemplate.has(x));
        if (!top.ids.has(id) && !named) {
          const near = closest(id, [...top.ids.keys()]);
          report('semantic/fragment-link', attrSpan(e, 'href'), `href="${href}" matches no id="${id}" on this page.${near ? ` Did you mean "#${near}"?` : ''}`);
        }
      }
    }

    // semantic/placeholder-content: attributes
    for (const a of e.attrs) {
      if (a.namespace) continue;
      const where = () => attrSpan(e, a.name);
      if ((a.name === 'href' || a.name === 'src' || a.name === 'action') && EXAMPLE_HOST.test(a.value.trim())) {
        report('semantic/placeholder-content', where(), `${a.name}="${a.value}" points at an example domain; use the real URL.`);
        continue;
      }
      if (['alt', 'title', 'placeholder', 'aria-label', 'value', 'content', 'href', 'src'].includes(a.name)) {
        const hit = PLACEHOLDERS.find((p) => p.pattern.test(a.value));
        if (hit) report('semantic/placeholder-content', where(), `${a.name} contains ${hit.what}; replace it with real content.`);
      }
    }
  }

  // semantic/placeholder-content: text
  for (const { node, parent } of walk(ctx.parsed.root)) {
    if (!isText(node) || !node.sourceCodeLocation || (parent && isElement(parent) && is(parent, 'script', 'style'))) continue;
    for (const p of PLACEHOLDERS) {
      const m = p.pattern.exec(node.value);
      if (!m) continue;
      const loc = node.sourceCodeLocation;
      const raw = ctx.text.slice(loc.startOffset, loc.endOffset);
      const at = raw.indexOf(m[0]);
      const offset = loc.startOffset + (at >= 0 ? at : 0);
      report('semantic/placeholder-content', { offset, endOffset: at >= 0 ? offset + m[0].length : loc.endOffset }, `The text contains ${p.what} ("${m[0].slice(0, 30)}"); replace it with real content.`);
    }
  }

  // semantic/list-candidate
  for (const { node } of walk(ctx.parsed.root)) {
    const kids = childrenOf(node).filter(isElement);
    let run: Element[] = [];
    const flush = () => {
      if (run.length >= 3) {
        reviews.push({ rule: 'semantic/list-candidate', ...span(run[0]!), ask: `These ${run.length} <${run[0]!.tagName} class="${attr(run[0]!, 'class')}"> siblings look like a list; would <ul> with <li> items fit?` });
      }
      run = [];
    };
    for (const kid of kids) {
      const cls = attr(kid, 'class')?.trim();
      const candidate = isHtml(kid) && cls && !NOT_LIST_CANDIDATES.has(kid.tagName) && kid.sourceCodeLocation;
      if (candidate && run.length && run[0]!.tagName === kid.tagName && attr(run[0]!, 'class')?.trim() === cls) run.push(kid);
      else {
        flush();
        if (candidate) run = [kid];
      }
    }
    flush();
  }

  return { findings, reviews };

  function hasOwnHeading(section: Element): boolean {
    const stack = [...section.childNodes];
    while (stack.length) {
      const n = stack.pop()!;
      if (!isElement(n)) continue;
      if (isHtml(n) && HEADINGS.has(n.tagName)) return true;
      if (explicitRole(n) === 'heading') return true;
      if (isHtml(n) && SECTIONING.has(n.tagName)) continue;
      stack.push(...n.childNodes);
    }
    return false;
  }
}

function nextSignificant(e: Element): ChildNode | null {
  const siblings = e.parentNode?.childNodes ?? [];
  for (let i = siblings.indexOf(e) + 1; i < siblings.length; i++) {
    const n = siblings[i]!;
    if (!isComment(n) && !isWhitespaceText(n)) return n;
  }
  return null;
}

function previousSignificant(e: Element): ChildNode | null {
  const siblings = e.parentNode?.childNodes ?? [];
  for (let i = siblings.indexOf(e) - 1; i >= 0; i--) {
    const n = siblings[i]!;
    if (!isComment(n) && !isWhitespaceText(n)) return n;
  }
  return null;
}

function textOf(e: Element): string {
  return childrenOf(e).map((c) => (isText(c) ? c.value : isElement(c) ? textOf(c) : '')).join('').replace(/\s+/g, ' ').trim();
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
