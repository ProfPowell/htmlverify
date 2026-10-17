import { isElement, isHtml, walk, type Element } from '../parse/tree.ts';
import { HTML, isEventHandler } from '../spec/data.ts';
import { NS } from '../spec/html.ts';
import { attr, tokens } from '../spec/model.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { at, readAttribute, spanOf } from './util.ts';

const is = (e: Element | null | undefined, ...names: string[]) => !!e && isHtml(e) && names.includes(e.tagName);

/** Attributes whose value is a URL, from the attribute index. */
const URL_ATTRIBUTES = new Set(HTML.attributes.filter((r) => /URL/.test(r.value)).map((r) => r.name));

/** The URL parser drops tabs and newlines and leading C0 controls and spaces before reading the scheme. */
function isJavaScriptUrl(value: string): boolean {
  return /^javascript:/i.test(value.replace(/[\t\n\r]/g, '').replace(/^[\0-\x20]+/, ''));
}

/** The policy rules (spec §6.7): house rules from the xhtml-author skill. */
export function checkPolicy(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const document = ctx.parsed.kind === 'document';
  const denied = new Set((ctx.ruleOptions['policy/elements']?.['deny'] as readonly string[] | undefined) ?? []);
  const span = (e: Element) => spanOf(e, ctx.text);
  const attrSpan = (e: Element, name: string) => {
    const loc = e.sourceCodeLocation?.attrs?.[name];
    return loc ? { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset } : span(e);
  };
  const report = (rule: string, where: { offset: number; endOffset: number }, message: string) => out.push({ rule, ...where, message });
  const h1s: Element[] = [];
  const templates = new Set<Element>();

  for (const { node, parent } of walk(ctx.parsed.root)) {
    if (!isElement(node)) continue;
    const inTemplate = parent !== null && isElement(parent) && (templates.has(parent) || is(parent, 'template'));
    if (inTemplate) templates.add(node);
    if (!node.sourceCodeLocation?.startTag) continue;
    const e = node;

    if (is(e, 'div') && !(parent && isElement(parent) && is(parent, 'dl'))) {
      report('policy/no-div', span(e), 'Replace <div> with a semantic element (section, article, header, nav, …), put data-layout on a semantic parent, or use a Vanilla Breeze layout element such as <layout-stack>.');
    }
    if (is(e, 'h1') && !inTemplate) h1s.push(e);
    if (is(e, 'button') && !e.attrs.some((a) => a.name === 'type')) {
      report('policy/button-type', span(e), 'Add type="button" (or type="submit" in a form): a <button> without type submits its form.');
    }
    if (is(e, 'b', 'i')) {
      report('policy/prefer-strong-em', span(e), e.tagName === 'b'
        ? 'Use <strong> for important text; <b> is for keywords and names that need no extra importance.'
        : 'Use <em> for stress emphasis; <i> is for terms, names, and phrases in another voice or language.');
    }
    if (e.namespaceURI === NS.svg && e.tagName === 'svg' && !(parent && isElement(parent) && parent.namespaceURI === NS.svg)) {
      report('policy/inline-svg', span(e), 'Use the icon component (<icon-wc name="…">) instead of inline <svg>.');
    }
    if (isHtml(e) && denied.has(e.tagName)) {
      report('policy/elements', span(e), `<${e.tagName}> is on this project’s denylist (policy/elements).`);
    }
    for (const a of e.attrs) {
      if (a.namespace) continue;
      if (isHtml(e) && isEventHandler(e.tagName, a.name)) {
        report('policy/inline-handler', attrSpan(e, a.name), `${a.name} runs inline script; use command and commandfor on buttons, or attach listeners from a script module.`);
      }
      if (URL_ATTRIBUTES.has(a.name) && isJavaScriptUrl(a.value)) {
        report('policy/javascript-url', attrSpan(e, a.name), `${a.name}="javascript:…" runs script from a URL; use a <button type="button"> with a listener, or a real URL.`);
      }
      if (a.name === 'style') report('policy/inline-style', attrSpan(e, 'style'), 'Move inline styles to a stylesheet, or to a class or data-layout attribute.');
      if (a.name === 'class') {
        const list = tokens(a.value);
        if (list.length === 0) report('policy/class', attrSpan(e, 'class'), 'Remove the empty class attribute.');
        const repeated = list.find((c, i) => list.indexOf(c) !== i);
        if (repeated) report('policy/class', attrSpan(e, 'class'), `class repeats "${repeated}"; list each class once.`);
      }
    }
  }

  if (document) {
    if (h1s.length === 0) {
      const body = ctx.parsed.root.childNodes.find((c): c is Element => isElement(c) && is(c, 'html'))?.childNodes.find((c): c is Element => isElement(c) && is(c, 'body'));
      report('policy/single-h1', body ? span(body) : { offset: 0, endOffset: 0 }, 'The page has no <h1>; give it one heading that names the page.');
    }
    for (const extra of h1s.slice(1)) {
      report('policy/single-h1', span(extra), `The page already has an <h1> at ${at(ctx, span(h1s[0]!).offset)}; use <h2> or lower for this one.`);
    }
    const head = ctx.parsed.root.childNodes.find((c): c is Element => isElement(c) && is(c, 'html'))?.childNodes.find((c): c is Element => isElement(c) && is(c, 'head'));
    if (head) {
      const children = head.childNodes.filter(isElement);
      const charset = children.find((c) => is(c, 'meta') && c.attrs.some((a) => a.name === 'charset'));
      if (charset && children[0] !== charset) report('policy/head', span(charset), '<meta charset="utf-8"> must be the first element in <head>.');
      if (!children.some((c) => is(c, 'meta') && attr(c, 'name')?.toLowerCase() === 'viewport')) {
        report('policy/head', span(head), '<head> has no <meta name="viewport" content="width=device-width, initial-scale=1">; add it so the page fits small screens.');
      }
    }
  }
  return out;
}
