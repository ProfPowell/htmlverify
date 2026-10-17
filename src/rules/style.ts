import { isBooleanAttribute, OPTIONAL_START_TAGS, VOID_ELEMENTS } from '../spec/html.ts';
import { childrenOf, isElement, isHtml, startOf, walk, type Document, type Element } from '../parse/tree.ts';
import { checkEscape } from './escape.ts';
import type { Edit, RawFinding, RuleContext } from './types.ts';
import { at, locatedElements, nameAt, readAttribute, startTagSpan } from './util.ts';
import { checkWhitespace } from './whitespace.ts';
import { vocabularyBooleans } from '../vocab/booleans.ts';

export function checkStyle(ctx: RuleContext, absorbed: Set<Element>): RawFinding[] {
  const findings: RawFinding[] = [];
  const tags = tagInsertions(ctx, absorbed);
  findings.push(...explicitStartTags(ctx, tags), ...explicitEndTags(ctx, absorbed, tags));
  const vocabularyBoolean = vocabularyBooleans(ctx.vocabulary);
  for (const element of locatedElements(ctx)) {
    findings.push(...attributes(ctx, element, vocabularyBoolean), ...tagCase(ctx, element));
    const void_ = voidForm(ctx, element);
    if (void_) findings.push(void_);
  }
  const doctype = doctypeForm(ctx);
  if (doctype) findings.push(doctype);
  findings.push(...checkEscape(ctx, absorbed), ...checkWhitespace(ctx));
  return findings;
}

interface TagInsertions {
  /** The combined edit at each offset where tags go. */
  edits: Map<number, Edit>;
  /** Where each element's missing start and end tags go. */
  start: Map<Element, number>;
  end: Map<Element, number>;
}

/**
 * Where the missing tags go: start tags where the parser implied the element,
 * end tags where it closed it. Tags meeting at one offset form one edit, in the
 * order the parser saw them: ends innermost first, then starts outermost first.
 */
function tagInsertions(ctx: RuleContext, absorbed: Set<Element>): TagInsertions {
  const order = new Map<Element, number>();
  for (const { node } of walk(ctx.parsed.root)) if (isElement(node)) order.set(node, order.size);
  const depth = (e: Element) => {
    let d = 0;
    for (let n = ctx.signals.parentOf.get(e); n && isElement(n); n = ctx.signals.parentOf.get(n)) d++;
    return d;
  };
  // A self-closed <textarea/> or <script/> holds the rest of the input as text; tags can't go there.
  const swallowed = [...absorbed]
    .filter((e) => ctx.signals.startToken.get(e)?.selfClosing)
    .map((e) => [e.sourceCodeLocation!.startTag!.endOffset, e.sourceCodeLocation!.endTag?.startOffset ?? ctx.text.length] as const);
  const insideSwallowed = (offset: number) => swallowed.some(([from, to]) => from <= offset && offset <= to);
  const start = new Map<Element, number>();
  const end = new Map<Element, number>();
  for (const element of ctx.signals.implied) {
    if (!OPTIONAL_START_TAGS.has(element.tagName)) continue;
    start.set(element, impliedAt(ctx, element));
    const closing = impliedEnd(ctx, element);
    if (closing !== null && !insideSwallowed(closing)) end.set(element, closing);
  }
  for (const u of ctx.signals.unclosed) {
    if (u.omissionAllowed && !absorbed.has(u.element) && !insideSwallowed(u.closedAt)) end.set(u.element, u.closedAt);
  }

  const at = new Map<number, { starts: Element[]; ends: Element[] }>();
  const slot = (offset: number) => at.get(offset) ?? at.set(offset, { starts: [], ends: [] }).get(offset)!;
  for (const [e, offset] of start) slot(offset).starts.push(e);
  for (const [e, offset] of end) slot(offset).ends.push(e);
  const edits = new Map<number, Edit>();
  for (const [offset, { starts, ends }] of at) {
    const opened = new Set(starts);
    // Elements that also start here are empty; they close in place, after their own start.
    const closes = ends.filter((e) => !opened.has(e)).sort((a, b) => depth(b) - depth(a));
    let text = closes.map((e) => `</${e.tagName}>`).join('');
    const stack: Element[] = [];
    const contains = (outer: Element, inner: Element) => {
      for (let n = ctx.signals.parentOf.get(inner); n; n = ctx.signals.parentOf.get(n)) if (n === outer) return true;
      return false;
    };
    for (const e of [...starts].sort((a, b) => order.get(a)! - order.get(b)!)) {
      while (stack.length && !contains(stack.at(-1)!, e)) text += `</${stack.pop()!.tagName}>`;
      text += `<${e.tagName}>`;
      if (ends.includes(e)) stack.push(e);
    }
    while (stack.length) text += `</${stack.pop()!.tagName}>`;
    edits.set(offset, { offset, endOffset: offset, text });
  }
  return { edits, start, end };
}

/**
 * Where an implied element ends: before the first token after its content
 * that doesn't close one of its descendants; null when its own end tag is
 * written, as in an implied <body> closed by </body>.
 */
function impliedEnd(ctx: RuleContext, element: Element): number | null {
  // An implied element owns no tags, so its written end tag counts as stray: </body> after an implied <body>.
  const from = impliedAt(ctx, element);
  const parent = ctx.signals.parentOf.get(element);
  const until = (parent && isElement(parent) ? parent.sourceCodeLocation?.endTag?.startOffset : undefined) ?? ctx.text.length;
  if (ctx.signals.strayEnd.some((t) => t.name === element.tagName && t.offset >= from && t.offset <= until)) return null;
  let last = -1;
  const open = new Set<string>();
  for (const { node } of walk(element)) {
    if (node === element || !node.sourceCodeLocation) continue;
    const loc = node.sourceCodeLocation as { endOffset: number; endTag?: { endOffset: number } };
    last = Math.max(last, loc.endTag?.endOffset ?? loc.endOffset);
  }
  // Descendants still open at the end of the content may be closed by the next end tags.
  for (let n: Element | undefined = element; n; ) {
    const kids: Element[] = childrenOf(n).filter(isElement);
    n = kids.at(-1);
    if (n) open.add(n.tagName);
  }
  if (last < 0) last = impliedAt(ctx, element);
  const ignored = new Set([...ctx.signals.strayEnd, ...ctx.signals.droppedStart]);
  for (const token of ctx.parsed.tokens) {
    if (token.offset < last || ignored.has(token)) continue;
    if (token.kind === 'end' && token.name === element.tagName) return null;
    if (token.kind === 'end' && open.has(token.name)) {
      open.delete(token.name);
      continue;
    }
    return token.offset;
  }
  return ctx.text.length;
}

function explicitStartTags(ctx: RuleContext, tags: TagInsertions): RawFinding[] {
  const out: RawFinding[] = [];
  for (const [element, offset] of tags.start) {
    const ending = tags.end.get(element);
    out.push({
      rule: 'style/explicit-start-tag',
      offset,
      endOffset: offset,
      message: `The <${element.tagName}> start tag is missing; the parser implied it at ${at(ctx, offset)}. Write <${element.tagName}> explicitly.`,
      fix: [tags.edits.get(offset)!, ...(ending !== undefined && ending !== offset ? [tags.edits.get(ending)!] : [])],
      evidence: { element: element.tagName },
    });
  }
  return out;
}

/** Where an implied element begins: its first located descendant, else the next located node. */
function impliedAt(ctx: RuleContext, element: Element): number {
  for (const { node } of walk(element)) {
    const start = node === element ? null : startOf(node);
    if (start !== null) return start;
  }
  let found: number | null = null;
  let passed = false;
  for (const { node } of walk(ctx.parsed.root)) {
    if (node === element) passed = true;
    else if (passed && startOf(node) !== null) {
      found = startOf(node);
      break;
    }
  }
  return found ?? ctx.text.length;
}

function explicitEndTags(ctx: RuleContext, absorbed: Set<Element>, tags: TagInsertions): RawFinding[] {
  const out: RawFinding[] = [];
  for (const u of ctx.signals.unclosed) {
    // Its end tag sits inside an element that swallowed it; syntax explains that.
    if (!u.omissionAllowed || absorbed.has(u.element) || !tags.end.has(u.element)) continue;
    const tag = u.element.tagName;
    const by = u.closedBy;
    let where = 'at the end of the file';
    if (by?.kind === 'start') where = `before <${by.name}> at ${at(ctx, by.offset)}`;
    else if (by) where = `before </${by.name}> at ${at(ctx, by.offset)}`;
    out.push({
      rule: 'style/explicit-end-tag',
      ...startTagSpan(u.element),
      message: `Close <${tag}> explicitly: add </${tag}> ${where}.`,
      fix: [tags.edits.get(u.closedAt)!],
      evidence: { element: tag },
    });
  }
  return out;
}

function booleanForm(name: string, form: NonNullable<RuleContext['options']['booleanValue']>): string {
  if (form === 'true') return `${name}="true"`;
  if (form === 'name') return `${name}="${name}"`;
  return `${name}=""`;
}

/** style/attr-quotes, style/boolean-attr, and attribute-name case. */
function attributes(ctx: RuleContext, element: Element, vocabularyBoolean: (element: Element, name: string) => boolean): RawFinding[] {
  const out: RawFinding[] = [];
  const locs = element.sourceCodeLocation?.attrs ?? {};
  for (const attr of element.attrs) {
    const canonical = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    const loc = locs[canonical.toLowerCase()];
    if (!loc) continue;
    const raw = readAttribute(ctx.text, loc.startOffset);
    const span = { offset: loc.startOffset, endOffset: raw.endOffset };

    if (raw.name !== canonical && raw.name.toLowerCase() === canonical.toLowerCase()) {
      out.push({
        rule: 'style/lowercase',
        ...span,
        message: isHtml(element)
          ? `Write the ${canonical} attribute in lowercase.`
          : `Write ${canonical} with this exact case; ${element.namespaceURI.endsWith('svg') ? 'SVG' : 'MathML'} names are case-sensitive.`,
        fix: [{ offset: loc.startOffset, endOffset: raw.nameEndOffset, text: canonical }],
        evidence: { attribute: raw.name },
      });
    }

    const form = ctx.options.booleanValue;
    if ((isHtml(element) && isBooleanAttribute(element.tagName, attr.name)) || (!attr.namespace && vocabularyBoolean(element, attr.name))) {
      const equivalent = attr.value === '' || attr.value === 'true' || attr.value.toLowerCase() === attr.name;
      const written = ctx.text.slice(raw.nameEndOffset, raw.endOffset);
      const wanted = booleanForm(attr.name, form ?? 'empty').slice(attr.name.length);
      if (form && equivalent && written !== wanted) {
        out.push({
          rule: 'style/boolean-attr',
          ...span,
          message: `Write ${booleanForm(attr.name, form)}: the house form for boolean attributes.`,
          fix: [{ offset: raw.nameEndOffset, endOffset: raw.endOffset, text: wanted }],
          evidence: { attribute: attr.name, written: ctx.text.slice(loc.startOffset, raw.endOffset) },
        });
      }
      continue;
    }

    if (raw.quote === '"') continue;
    const value = ctx.text.slice(raw.valueOffset, raw.valueEndOffset);
    const fix: Edit[] = raw.quote === 'bare'
      ? [{ offset: raw.nameEndOffset, endOffset: raw.nameEndOffset, text: '=""' }]
      : [{
          offset: raw.quote === 'none' ? raw.valueOffset : raw.valueOffset - 1,
          endOffset: raw.quote === 'none' ? raw.valueEndOffset : raw.valueEndOffset + 1,
          text: `"${value.replaceAll('"', '&quot;')}"`,
        }];
    const message = raw.quote === 'bare'
      ? `${canonical} has no value; write ${canonical}="…".`
      : `Quote the value with double quotes: ${canonical}="${value.replaceAll('"', '&quot;')}".`;
    out.push({ rule: 'style/attr-quotes', ...span, message, fix, evidence: { attribute: canonical, quote: raw.quote } });
  }
  return out;
}

/** Element-name case for start and end tags. */
function tagCase(ctx: RuleContext, element: Element): RawFinding[] {
  const loc = element.sourceCodeLocation!;
  const startName = nameAt(ctx.text, loc.startTag!.startOffset + 1);
  const canonical = element.tagName;
  if (startName.toLowerCase() !== canonical.toLowerCase()) return [];
  const fix: Edit[] = [];
  if (startName !== canonical) fix.push({ offset: loc.startTag!.startOffset + 1, endOffset: loc.startTag!.startOffset + 1 + startName.length, text: canonical });
  if (loc.endTag) {
    const endName = nameAt(ctx.text, loc.endTag.startOffset + 2);
    if (endName !== canonical && endName.toLowerCase() === canonical.toLowerCase()) {
      fix.push({ offset: loc.endTag.startOffset + 2, endOffset: loc.endTag.startOffset + 2 + endName.length, text: canonical });
    }
  }
  if (fix.length === 0) return [];
  return [{
    rule: 'style/lowercase',
    ...startTagSpan(element),
    message: isHtml(element)
      ? `Write <${canonical}> in lowercase.`
      : `Write <${canonical}> with this exact case; ${element.namespaceURI.endsWith('svg') ? 'SVG' : 'MathML'} names are case-sensitive.`,
    fix,
    evidence: { element: startName },
  }];
}

const VOID_FORMS = { xhtml: '<br />', tight: '<br/>', html: '<br>' } as const;

function voidForm(ctx: RuleContext, element: Element): RawFinding | null {
  if (!isHtml(element) || !VOID_ELEMENTS.has(element.tagName)) return null;
  const token = ctx.signals.startToken.get(element);
  if (!token) return null;
  const tag = ctx.text.slice(token.offset, token.endOffset);
  // The token decides self-closing: in `<img src=a/>` the slash belongs to the value.
  let suffix = token.selfClosing ? /[\t\n\f\r ]*\/>$/.exec(tag)![0] : /[\t\n\f\r ]*>$/.exec(tag)![0];
  const style = ctx.options.voidElements;
  let wanted = style === 'xhtml' ? ' />' : style === 'tight' ? '/>' : '>';
  // A tag that closes on its own line keeps that line break: only the slash is in question.
  if (/[\n\r]/.test(suffix)) {
    suffix = token.selfClosing ? '/>' : '>';
    wanted = wanted.trimStart();
  }
  if (suffix === wanted) return null;
  const example = VOID_FORMS[style].replace('br', element.tagName);
  return {
    rule: 'style/void-element',
    offset: token.offset,
    endOffset: token.endOffset,
    message: `Write void elements as ${example}.`,
    fix: [{ offset: token.endOffset - suffix.length, endOffset: token.endOffset, text: wanted }],
    evidence: { element: element.tagName },
  };
}

function doctypeForm(ctx: RuleContext): RawFinding | null {
  if (ctx.parsed.kind !== 'document') return null;
  const node = (ctx.parsed.root as Document).childNodes.find((n) => n.nodeName === '#documentType');
  if (!node || !('name' in node) || !node.sourceCodeLocation) return null;
  if (node.name !== 'html' || node.publicId || node.systemId) return null;
  const { startOffset, endOffset } = node.sourceCodeLocation;
  if (ctx.text.slice(startOffset, endOffset) === '<!doctype html>') return null;
  return {
    rule: 'style/doctype',
    offset: startOffset,
    endOffset,
    message: 'Write the doctype exactly as <!doctype html>.',
    fix: [{ offset: startOffset, endOffset, text: '<!doctype html>' }],
  };
}

