import { Names } from '../analysis/names.ts';
import { childrenOf, isElement, isHtml, isText, walk, type Element } from '../parse/tree.ts';
import { ARIA, ariaValueProblem, attributeData, allowedOnRole, requiredAttributes, roleData } from '../spec/aria.ts';
import { NS } from '../spec/html.ts';
import { EXTENSION_ROLES, explicitRole, semanticsOf, type Semantics } from '../spec/html-aria.ts';
import { attr, has, inputType } from '../spec/model.ts';
import { languageTagProblem } from '../spec/values.ts';
import { closest, words } from '../text.ts';
import type { RawFinding, RawReview, RuleContext } from './types.ts';
import { at, readAttribute, spanOf } from './util.ts';

export interface A11yResult {
  findings: RawFinding[];
  reviews: RawReview[];
}

const is = (e: Element | null | undefined, ...names: string[]) => !!e && isHtml(e) && names.includes(e.tagName);
const quote = (s: string, max = 40) => `"${s.length > max ? `${s.slice(0, max)}…` : s}"`;

/** Controls a11y/label covers; every other name-requiring role is a11y/name's. */
const LABELED_INPUTS = new Set(['button', 'hidden', 'image', 'reset', 'submit']);
function isFormControl(e: Element): boolean {
  return is(e, 'select', 'textarea') || (is(e, 'input') && !LABELED_INPUTS.has(inputType(e)));
}

const GENERIC_LINK_TEXT: Record<'en', ReadonlySet<string>> = {
  en: new Set([
    'click here', 'click', 'here', 'read more', 'more', 'learn more', 'link', 'this', 'this link', 'details',
    'more info', 'more information', 'continue', 'go', 'info', 'see more', 'view more', 'find out more', 'more details',
  ]),
};

/**
 * The a11y rules (spec §6.5): static checks that establish failures, and
 * review items for what only a person can judge.
 */
export function checkA11y(ctx: RuleContext): A11yResult {
  const names = new Names(ctx.parsed.root, ctx.parsed.kind, ctx.signals.parentOf, ctx.parsed.context);
  const document = ctx.parsed.kind === 'document';
  const findings: RawFinding[] = [];
  const reviews: RawReview[] = [];
  const elements: Element[] = [];
  for (const { node } of walk(ctx.parsed.root)) if (isElement(node) && node.sourceCodeLocation?.startTag) elements.push(node);

  const span = (e: Element) => spanOf(e, ctx.text);
  const attrSpan = (e: Element, name: string) => {
    const loc = e.sourceCodeLocation?.attrs?.[name];
    return loc ? { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset } : span(e);
  };
  const report = (rule: string, where: { offset: number; endOffset: number }, message: string, extra: Partial<RawFinding> = {}) =>
    findings.push({ rule, ...where, message, ...extra });
  const review = (rule: string, where: { offset: number; endOffset: number }, ask: string) => reviews.push({ rule, ...where, ask });
  const pos = (e: Element) => at(ctx, span(e).offset);
  const semantics = new Map<Element, Semantics | null>();
  const semanticsFor = (e: Element) => {
    if (!semantics.has(e)) semantics.set(e, semanticsOf(e, names.ancestors(e)));
    return semantics.get(e)!;
  };
  const inTemplate = (e: Element) => names.ancestors(e).some((a) => is(a, 'template'));
  const visible = (e: Element) => !names.hidden(e);
  const disabled = (e: Element): boolean => {
    if (is(e, 'button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset') && has(e, 'disabled')) return true;
    return names.ancestors(e).some((a, i, list) => {
      if (!is(a, 'fieldset') || !has(a, 'disabled')) return false;
      const legend = a.childNodes.find((c) => isElement(c) && is(c, 'legend'));
      return !(legend && (list[i - 1] === legend || list.slice(0, i).includes(legend as Element)));
    });
  };
  /** Reachable with the keyboard by default (tabindex="-1" excluded). */
  const focusable = (e: Element): boolean => {
    if (names.ancestors(e).some((a) => has(a, 'inert')) || has(e, 'inert')) return false;
    const tabindex = attr(e, 'tabindex');
    if (tabindex !== null && /^-?\d+$/.test(tabindex.trim())) return Number(tabindex) >= 0 && !disabled(e);
    if (!isHtml(e)) return false;
    switch (e.tagName) {
      case 'a':
      case 'area':
        return has(e, 'href');
      case 'button':
      case 'select':
      case 'textarea':
        return !disabled(e);
      case 'input':
        return inputType(e) !== 'hidden' && !disabled(e);
      case 'iframe':
        return true;
      case 'audio':
      case 'video':
        return has(e, 'controls');
      case 'summary': {
        const parent = names.ancestors(e)[0];
        return is(parent, 'details') && parent!.childNodes.find((c) => isElement(c) && is(c, 'summary')) === e;
      }
    }
    const editable = attr(e, 'contenteditable');
    return editable !== null && editable.toLowerCase() !== 'false';
  };

  // a11y/lang and a11y/title (documents).
  if (document) {
    const html = elements.find((e) => is(e, 'html')) ?? null;
    const htmlNode = ctx.parsed.root.childNodes.find((c): c is Element => isElement(c) && is(c, 'html'));
    if (htmlNode) {
      // xml:lang alone sets nothing in HTML.
      const lang = attr(htmlNode, 'lang');
      const where = html ? span(html) : { offset: 0, endOffset: 0 };
      if (lang === null) report('a11y/lang', where, '<html> needs lang, such as lang="en": assistive technology uses it to pick a language (WCAG 3.1.1).');
      else if (lang.trim() === '') report('a11y/lang', attrSpan(htmlNode, 'lang'), 'lang on <html> is empty; name the page’s language, such as lang="en" (WCAG 3.1.1).');
      else review('a11y/lang', attrSpan(htmlNode, 'lang'), `Does lang=${quote(lang)} match the language of the page’s content?`);
    }
    const head = htmlNode?.childNodes.find((c): c is Element => isElement(c) && is(c, 'head'));
    if (head) {
      const titles = head.childNodes.filter((c): c is Element => isElement(c) && is(c, 'title'));
      if (titles.length === 0) {
        report('a11y/title', span(head), 'The page has no <title>; add one that describes the page (WCAG 2.4.2).', { defect: 'title-missing' });
      } else {
        const text = titles[0]!.childNodes.filter(isText).map((t) => t.value).join('').trim();
        if (text === '') report('a11y/title', span(titles[0]!), 'The page title is empty; describe the page (WCAG 2.4.2).', { defect: 'title-empty' });
        else review('a11y/title', span(titles[0]!), `Does the title ${quote(text, 60)} describe the page’s topic or purpose?`);
      }
    }
  }
  // An ill-formed lang is a content/attribute-value finding too; the two merge.
  for (const e of elements) {
    const value = isHtml(e) ? attr(e, 'lang') : null;
    if (value && languageTagProblem(value)) {
      report('a11y/lang', attrSpan(e, 'lang'), `lang=${quote(value)} isn’t a well-formed language tag, so assistive technology can’t use it (WCAG 3.1.1, 3.1.2).`, { defect: 'lang-value' });
    }
  }

  for (const e of elements) {
    // Name and label rules skip what isn't exposed; ARIA validity applies everywhere.
    const shown = visible(e);
    const role = names.role(e);
    const sem = semanticsFor(e);
    const explicit = explicitRole(e);
    if (shown) checkExposed(e, role, explicit);

    checkAria(e, role, explicit, sem);
  }

  /** a11y/img-alt, a11y/svg, a11y/label, a11y/name, and a11y/tabindex, for elements that are exposed. */
  function checkExposed(e: Element, role: string | null, explicit: string | null) {
    // a11y/img-alt
    if (is(e, 'img') && !has(e, 'alt')) {
      const named = names.name(e);
      if (!named.name) report('a11y/img-alt', span(e), '<img> needs alt: describe the image, or write alt="" if it’s decorative (WCAG 1.1.1).');
    } else if (is(e, 'img')) {
      const alt = attr(e, 'alt')!;
      if (alt.trim() === '') review('a11y/img-alt', attrSpan(e, 'alt'), 'Is this image purely decorative? alt="" hides it from screen readers.');
      else if (/\.(?:png|jpe?g|gif|svg|webp|avif|bmp|tiff?)$/i.test(alt.trim()) || /^(?:image|img|photo|picture|graphic|icon|logo)$/i.test(alt.trim())) {
        review('a11y/img-alt', attrSpan(e, 'alt'), `alt=${quote(alt)} doesn’t describe anything; what does the image show, or is it decorative?`);
      } else review('a11y/img-alt', attrSpan(e, 'alt'), `Does alt=${quote(alt)} convey what the image shows here?`);
    }
    if (is(e, 'input') && inputType(e) === 'image' && !names.name(e).name) {
      report('a11y/img-alt', span(e), '<input type="image"> needs alt that says what the button does (WCAG 1.1.1).');
    }
    if (is(e, 'area') && has(e, 'href') && !has(e, 'alt') && !names.name(e).name) {
      report('a11y/img-alt', span(e), '<area href> needs alt that names the link target (WCAG 1.1.1).');
    }
    if ((explicit === 'img' || explicit === 'image') && !is(e, 'img') && e.namespaceURI !== NS.svg && !names.name(e).name) {
      report('a11y/img-alt', span(e), `role="${explicit}" needs a name: add aria-label or aria-labelledby (WCAG 1.1.1).`);
    }

    // a11y/svg
    if (e.namespaceURI === NS.svg && e.tagName === 'svg' && !(e.parentNode && isElement(e.parentNode) && e.parentNode.namespaceURI === NS.svg)) {
      if (attr(e, 'aria-hidden') !== 'true') {
        const named = names.name(e).name !== '';
        if (!(explicit === 'img' || explicit === 'image') || !named) {
          report('a11y/svg', span(e), explicit === 'img' || explicit === 'image'
            ? '<svg role="img"> needs a name: add aria-label, or a <title> as its first child.'
            : 'Inline <svg> needs aria-hidden="true" if it’s decorative, or role="img" and a name (aria-label or <title>) if it conveys meaning.');
        }
      }
    }

    // a11y/label
    if (isHtml(e) && isFormControl(e)) {
      const n = names.name(e);
      const what = describeControl(e);
      if (n.source === 'placeholder') report('a11y/label', span(e), `${what} is labeled only by its placeholder, which disappears on input. Add <label for="…">…</label> (WCAG 1.3.1, 3.3.2).`, { evidence: { name: n.name, source: 'placeholder' } });
      else if (n.source === 'title') report('a11y/label', span(e), `${what} is labeled only by its title. Add a visible <label for="…">…</label> (WCAG 3.3.2).`, { severity: 'warning', evidence: { name: n.name, source: 'title' } });
      else if (!n.name) report('a11y/label', span(e), `${what} has no label. Add <label for="…">…</label> or wrap it in a label (WCAG 1.3.1, 4.1.2).`, { evidence: { name: '' } });
    }

    // a11y/name
    const needsName = role !== null && (roleData(role)?.nameRequired || role === 'dialog' || role === 'alertdialog');
    // Covered by other rules, or never rendered on its own (datalist).
    const exempt = isFormControl(e) || is(e, 'img', 'area', 'th', 'td', 'option', 'datalist') || (is(e, 'input') && inputType(e) === 'image') ||
      role === 'heading' || role === 'img' || role === 'image' || (e.namespaceURI === NS.svg && e.tagName === 'svg');
    if ((needsName || is(e, 'iframe')) && !exempt && !names.name(e).name) {
      const label = is(e, 'iframe') ? '<iframe> needs a title that describes its content (WCAG 4.1.2).'
        : role === 'link' ? `${describeElement(e)} has no accessible name: give it link text, or aria-label for an icon link (WCAG 2.4.4, 4.1.2).`
        : role === 'button' ? `${describeElement(e)} has no accessible name: give it text, or aria-label for an icon button (WCAG 4.1.2).`
        : `${describeElement(e)} with role ${role} has no accessible name: add aria-label or aria-labelledby (WCAG 4.1.2).`;
      report('a11y/name', span(e), label, { evidence: { role: role ?? 'none', name: '' } });
    }

    // a11y/tabindex
    const tabindex = attr(e, 'tabindex');
    if (tabindex !== null && /^\s*-?\d+\s*$/.test(tabindex)) {
      const n = Number(tabindex);
      if (n > 0) report('a11y/tabindex', attrSpan(e, 'tabindex'), `tabindex="${tabindex.trim()}" changes the tab order; use 0 and arrange the source order instead (WCAG 2.4.3).`);
      else if (n === 0 && (role === null || role === 'generic') && isHtml(e) && !focusableNatively(e)) {
        report('a11y/tabindex', attrSpan(e, 'tabindex'), `tabindex="0" makes ${describeElement(e)} focusable, but it has no role: use a <button> or <a href>, or give it a role.`, { defect: 'focusable-without-role' });
      }
    }
  }

  /** a11y/aria-role, a11y/aria-attr, and a11y/aria-redundant. */
  function checkAria(e: Element, role: string | null, explicit: string | null, sem: Semantics | null) {
    // a11y/aria-role
    if (explicit !== null && e.sourceCodeLocation?.attrs?.['role'] && (isHtml(e) || e.tagName === 'svg')) {
      const where = attrSpan(e, 'role');
      const data = roleData(explicit);
      if (!data && !EXTENSION_ROLES.has(explicit)) {
        const near = closest(explicit, Object.keys(ARIA.roles).filter((r) => !roleData(r)!.abstract));
        report('a11y/aria-role', where, `role="${explicit}" isn’t an ARIA role.${near ? ` Did you mean "${near}"?` : ''}`);
      } else if (data?.abstract) {
        report('a11y/aria-role', where, `role="${explicit}" is an abstract role for the ARIA ontology; authors must not use it.`);
      } else {
        if (data?.deprecated) report('a11y/aria-role', where, `role="${explicit}" is deprecated in ARIA.`, { severity: 'warning' });
        if (sem && sem.allowed !== 'any' && !sem.allowed.has(explicit) && !(explicit === 'presentation' && sem.allowed.has('none')) && !(explicit === 'none' && sem.allowed.has('presentation')) && !(explicit === 'image' && sem.allowed.has('img')) && !(explicit === 'img' && sem.allowed.has('image'))) {
          const allowed = [...sem.allowed].filter((r) => !sem.discouraged.has(r));
          report('a11y/aria-role', where, allowed.length === 0 && sem.allowed.size === 0
            ? `${describeElement(e)} can’t take a role (ARIA in HTML).`
            : `role="${explicit}" isn’t allowed on ${describeElement(e)}${allowed.length && allowed.length <= 8 ? `; allowed roles: ${words(allowed)}` : ''} (ARIA in HTML).`);
        }
        const parents = data?.requiredParents ?? [];
        if (parents.length) {
          const owner = names.ancestors(e).map((a) => names.role(a)).find((r) => r !== null && r !== 'generic' && r !== 'none' && r !== 'presentation');
          if (!owner || !parents.includes(owner)) {
            report('a11y/aria-role', where, `role="${explicit}" must be inside an element with role ${words([...new Set(parents)], 'or')}${owner ? `; its nearest role here is ${owner}` : ''}.`);
          }
        }
      }
    }

    // a11y/aria-attr
    if (isHtml(e) || (e.namespaceURI === NS.svg && e.tagName === 'svg')) {
      const effective = explicit && roleData(explicit) && !roleData(explicit)!.abstract ? explicit : role;
      const extension = explicit !== null && EXTENSION_ROLES.has(explicit);
      for (const a of e.attrs) {
        if (!a.name.startsWith('aria-') || a.namespace) continue;
        const where = attrSpan(e, a.name);
        const data = attributeData(a.name);
        if (!data) {
          const near = closest(a.name, Object.keys(ARIA.attributes));
          report('a11y/aria-attr', where, `${a.name} isn’t an ARIA attribute.${near ? ` Did you mean ${near}?` : ''}`);
          continue;
        }
        if (data.deprecated) {
          report('a11y/aria-attr', where, `${a.name} is deprecated in ARIA; remove it.`, { severity: 'warning' });
          continue;
        }
        const problem = ariaValueProblem(a.name, a.value);
        if (problem) report('a11y/aria-attr', where, `${a.name}=${quote(a.value)} ${problem}.`);
        if (!sem) continue;
        if (sem.mustNot.includes(a.name)) {
          report('a11y/aria-attr', where, `Don’t use ${a.name} on ${describeElement(e)}; ${a.name === 'aria-checked' ? 'the checked attribute sets the state' : 'HTML provides it natively'} (ARIA in HTML).`);
          continue;
        }
        if (sem.shouldNot.includes(a.name)) {
          report('a11y/aria-attr', where, `Avoid ${a.name} on ${describeElement(e)}: HTML provides it natively (ARIA in HTML).`, { severity: 'warning' });
          continue;
        }
        if (sem.aria === 'none' && !explicit) {
          report('a11y/aria-attr', where, `${describeElement(e)} can’t have aria-* attributes (ARIA in HTML).`);
          continue;
        }
        if (sem.aria === 'hidden-only' && !explicit) {
          if (!(a.name === 'aria-hidden' && a.value === 'true')) report('a11y/aria-attr', where, `${describeElement(e)} allows only aria-hidden="true" (ARIA in HTML).`);
          continue;
        }
        if (extension) continue;
        const naming = a.name === 'aria-label' || a.name === 'aria-labelledby' || a.name === 'aria-braillelabel';
        if (naming && (sem.namingProhibited && !explicit)) {
          report('a11y/aria-attr', where, `${a.name} isn’t allowed on ${describeElement(e)}${effective ? ` (role ${effective})` : ''}, which can’t be named; use a different element, or put the text in the content.`);
          continue;
        }
        const policyRole = typeof sem.aria === 'object' && 'role' in sem.aria && !explicit ? sem.aria.role : effective;
        const extra = typeof sem.aria === 'object' && 'extra' in sem.aria && !explicit ? sem.aria.extra : [];
        if (extra.includes(a.name)) continue;
        const verdict = sem.aria === 'global' && !explicit ? allowedOnRole(a.name, null) : allowedOnRole(a.name, policyRole);
        if (verdict === 'prohibited') {
          report('a11y/aria-attr', where, naming
            ? `${a.name} isn’t allowed on ${describeElement(e)} (role ${policyRole}), which can’t be named; use a different element, or put the text in the content.`
            : `${a.name} is prohibited on role ${policyRole}.`);
        } else if (verdict === 'no') {
          report('a11y/aria-attr', where, `${a.name} isn’t supported on ${describeElement(e)}${policyRole ? ` (role ${policyRole})` : ''}.`);
        } else if (verdict === 'deprecated-global') {
          report('a11y/aria-attr', where, `${a.name} is deprecated as a global attribute, and ${policyRole ? `role ${policyRole}` : describeElement(e)} doesn’t support it.`, { severity: 'warning' });
        }
      }
      // Required states and properties of an explicit role on an element that doesn't provide them natively.
      if (explicit && roleData(explicit) && !roleData(explicit)!.abstract && !providesNatively(e)) {
        const conditions = roleData(explicit)!.conditions;
        for (const required of requiredAttributes(explicit)) {
          if (has(e, required)) continue;
          if (conditions[required] === 'if focusable' && !focusable(e)) continue;
          report('a11y/aria-attr', attrSpan(e, 'role'), `role="${explicit}" needs ${required}${attributeData(required)?.values.length ? ` (${words(attributeData(required)!.values.filter((v) => v !== 'undefined').map((v) => `"${v}"`))})` : ''}.`);
        }
      }
    }

    // a11y/aria-redundant
    if (explicit && sem && (explicit === sem.implicit || (explicit === 'img' && sem.implicit === 'image') || (explicit === 'image' && sem.implicit === 'img'))) {
      const workaround = (explicit === 'list' && is(e, 'ul', 'ol', 'menu')) || (explicit === 'listitem' && is(e, 'li'));
      if (!workaround) report('a11y/aria-redundant', attrSpan(e, 'role'), `role="${explicit}" is redundant on ${describeElement(e)}, which has that role already; remove it.`);
    }
  }

  // a11y/aria-hidden-focus: focusable elements in an aria-hidden subtree that is rendered.
  for (const e of elements) {
    if (attr(e, 'aria-hidden') !== 'true' || has(e, 'hidden')) continue;
    // Start from the outermost aria-hidden, so nested ones report once.
    if (names.ancestors(e).some((a) => has(a, 'hidden') || attr(a, 'aria-hidden') === 'true')) continue;
    const stack: Element[] = [e];
    while (stack.length) {
      const node = stack.pop()!;
      if (has(node, 'hidden') || is(node, 'template')) continue;
      stack.push(...node.childNodes.filter(isElement));
      if (!focusable(node)) continue;
      report('a11y/aria-hidden-focus', span(node), node === e
        ? `${describeElement(node)} has aria-hidden="true" but is focusable: keyboard users reach it, screen readers don’t. Remove aria-hidden, or make it unfocusable.`
        : `${describeElement(node)} is focusable inside aria-hidden="true" (at ${pos(e)}): keyboard users reach it, screen readers don’t. Remove aria-hidden, or make it unfocusable (tabindex="-1", disabled, or inert).`);
    }
  }

  // a11y/headings
  {
    const headings = elements
      .filter((e) => visible(e) && !inTemplate(e) && (/^h[1-6]$/.test(e.tagName) && isHtml(e) ? explicitRole(e) === null || explicitRole(e) === 'heading' : explicitRole(e) === 'heading'))
      .map((e) => ({ e, level: /^h[1-6]$/.test(e.tagName) && isHtml(e) && !has(e, 'aria-level') ? Number(e.tagName[1]) : Number(attr(e, 'aria-level') ?? 2) }));
    let previous: { e: Element; level: number } | null = null;
    for (const h of headings) {
      if (!names.name(h.e).name) report('a11y/headings', span(h.e), `${describeElement(h.e)} is empty; give it text, or remove it (WCAG 1.3.1, 2.4.6).`);
      if (previous === null && document && h.level !== 1) {
        report('a11y/headings', span(h.e), `The first heading is ${headingName(h)}; start the page with <h1> (WCAG 1.3.1).`, { severity: 'warning' });
      }
      if (previous && h.level > previous.level + 1) {
        const instead = isHtml(h.e) && /^h[1-6]$/.test(h.e.tagName) ? `<h${previous.level + 1}>` : `aria-level="${previous.level + 1}"`;
        const name = headingName(h);
        report('a11y/headings', span(h.e), `${name.charAt(0).toUpperCase()}${name.slice(1)} follows ${headingName(previous)}; use ${instead} (WCAG 1.3.1).`, { severity: 'warning' });
      }
      previous = h;
    }
  }

  // a11y/landmarks
  {
    const landmarks = elements.filter((e) => visible(e) && !inTemplate(e)).map((e) => ({ e, role: names.role(e) }));
    for (const [role, label] of [['navigation', '<nav>'], ['complementary', '<aside>'], ['region', 'named <section>']] as const) {
      const list = landmarks.filter((l) => l.role === role);
      if (list.length < 2) continue;
      const seen = new Map<string, Element>();
      for (const l of list) {
        const name = names.name(l.e).name;
        const first = seen.get(name.toLowerCase());
        if (first) {
          report('a11y/landmarks', span(l.e), name
            ? `This ${label} landmark has the same name as the one at ${pos(first)} (${quote(name)}); give each a distinct aria-label.`
            : `This ${label} landmark and the one at ${pos(first)} have no names; label each with aria-label, such as "Main" and "Footer".`);
        } else seen.set(name.toLowerCase(), l.e);
      }
    }
    for (const [role, label] of [['banner', '<header>'], ['contentinfo', '<footer>']] as const) {
      const list = landmarks.filter((l) => l.role === role);
      for (const extra of list.slice(1)) {
        report('a11y/landmarks', span(extra.e), `More than one top-level ${label} (${role}); the first is at ${pos(list[0]!.e)}. Keep one, or move this one into a section.`);
      }
    }
  }

  // a11y/link-text
  for (const e of elements) {
    if (!visible(e) || names.role(e) !== 'link') continue;
    const name = names.name(e).name;
    const plain = name.toLowerCase().replace(/[.,:;!?…→»›>]+/g, '').replace(/\s+/g, ' ').trim();
    if (GENERIC_LINK_TEXT[ctx.options.linkTextLanguage].has(plain)) {
      report('a11y/link-text', span(e), `Link text ${quote(name)} doesn’t say where the link goes; describe the destination, such as "Read the pricing guide" (WCAG 2.4.4).`);
    }
  }

  // a11y/form-group
  {
    const groups = new Map<string, Element[]>();
    for (const e of elements) {
      if (!is(e, 'input') || !visible(e) || inTemplate(e)) continue;
      const type = inputType(e);
      const name = attr(e, 'name');
      if ((type !== 'radio' && type !== 'checkbox') || !name) continue;
      const form = attr(e, 'form') ?? names.ancestors(e).find((a) => is(a, 'form'));
      const key = `${type}\0${name}\0${typeof form === 'string' ? form : form ? span(form).offset : ''}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const [key, inputs] of groups) {
      if (inputs.length < 2) continue;
      const grouped = (e: Element) => names.ancestors(e).some((a) =>
        (is(a, 'fieldset') && a.childNodes.some((c) => isElement(c) && is(c, 'legend') && childrenOf(c).length > 0)) ||
        ((explicitRole(a) === 'group' || explicitRole(a) === 'radiogroup') && names.name(a).name !== ''));
      if (inputs.every(grouped)) continue;
      const [type, name] = key.split('\0');
      report('a11y/form-group', span(inputs[0]!), `The ${inputs.length} ${type === 'radio' ? 'radio buttons' : 'checkboxes'} named "${name}" need a group label: wrap them in <fieldset> with a <legend> (WCAG 1.3.1).`);
    }
  }

  // a11y/table
  for (const e of elements) {
    if (!is(e, 'table') || !visible(e)) continue;
    const role = explicitRole(e);
    if (role === 'presentation' || role === 'none') continue;
    const cells = [...walk(e)].map((w) => w.node).filter((n): n is Element => isElement(n) && is(n, 'td', 'th'));
    const headers = cells.some((c) => is(c, 'th') || ['columnheader', 'rowheader'].includes(explicitRole(c) ?? ''));
    if (headers) continue;
    const rows = [...walk(e)].map((w) => w.node).filter((n): n is Element => isElement(n) && is(n, 'tr'));
    const layout = rows.length <= 1 || cells.length <= 1 || cells.some((c) => [...walk(c)].some((w) => isElement(w.node) && is(w.node, 'table', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'ul', 'ol')));
    if (layout) review('a11y/table', span(e), 'Is this table used for layout? Use CSS for layout; if it holds data, add <th> header cells.');
    else report('a11y/table', span(e), 'This data table has no header cells; mark row or column headers with <th> (WCAG 1.3.1).');
  }

  // a11y/media
  for (const e of elements) {
    if (!is(e, 'video', 'audio') || !visible(e)) continue;
    if (has(e, 'autoplay') && !has(e, 'muted')) {
      report('a11y/media', attrSpan(e, 'autoplay'), `<${e.tagName} autoplay> plays sound without being asked; add muted, or remove autoplay (WCAG 1.4.2).`);
    }
    if (is(e, 'video')) {
      const captions = e.childNodes.some((c) => isElement(c) && is(c, 'track') && ['captions', 'subtitles'].includes(attr(c, 'kind')?.toLowerCase() ?? 'subtitles'));
      if (!captions) review('a11y/media', span(e), 'Does this video have speech or meaningful sound? Then it needs captions: add <track kind="captions">.');
    }
  }

  return { findings, reviews };
}

/** Elements whose states come from HTML rather than aria-* attributes. */
function providesNatively(e: Element): boolean {
  return is(e, 'input', 'select', 'textarea', 'meter', 'progress', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'summary', 'dialog');
}

function focusableNatively(e: Element): boolean {
  return is(e, 'a', 'area', 'button', 'input', 'select', 'textarea', 'iframe', 'summary', 'audio', 'video') || attr(e, 'contenteditable') !== null;
}

function headingName(h: { e: Element; level: number }): string {
  return /^h[1-6]$/.test(h.e.tagName) && isHtml(h.e) ? `<${h.e.tagName}>` : `a level-${h.level} heading`;
}

function describeElement(e: Element): string {
  if (is(e, 'a') && has(e, 'href')) return '<a href>';
  if (is(e, 'input')) return `<input type="${inputType(e)}">`;
  return `<${e.tagName}>`;
}

function describeControl(e: Element): string {
  const name = attr(e, 'name') ?? attr(e, 'id');
  const type = is(e, 'input') ? ` type="${inputType(e)}"` : '';
  return `<${e.tagName}${type}${name ? ` ${attr(e, 'name') !== null ? 'name' : 'id'}="${name}"` : ''}>`;
}

