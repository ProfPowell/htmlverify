import { isBooleanAttribute, OPTIONAL_START_TAGS, VOID_ELEMENTS } from '../spec/html.ts';
import { isHtml, startOf, walk, type Document, type Element } from '../parse/tree.ts';
import type { Edit, RawFinding, RuleContext } from './types.ts';
import { at, locatedElements, nameAt, readAttribute, startTagSpan } from './util.ts';

export function checkStyle(ctx: RuleContext, absorbed: Set<Element>): RawFinding[] {
  const findings: RawFinding[] = [];
  findings.push(...explicitStartTags(ctx), ...explicitEndTags(ctx, absorbed));
  for (const element of locatedElements(ctx)) {
    findings.push(...attributes(ctx, element), ...tagCase(ctx, element));
    const void_ = voidForm(ctx, element);
    if (void_) findings.push(void_);
  }
  const doctype = doctypeForm(ctx);
  if (doctype) findings.push(doctype);
  return findings;
}

function explicitStartTags(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  for (const element of ctx.signals.implied) {
    if (!OPTIONAL_START_TAGS.has(element.tagName)) continue;
    const offset = impliedAt(ctx, element);
    out.push({
      rule: 'style/explicit-start-tag',
      offset,
      endOffset: offset,
      message: `The <${element.tagName}> start tag is missing; the parser implied it at ${at(ctx, offset)}. Write <${element.tagName}> explicitly.`,
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

function explicitEndTags(ctx: RuleContext, absorbed: Set<Element>): RawFinding[] {
  const out: RawFinding[] = [];
  for (const u of ctx.signals.unclosed) {
    if (!u.omissionAllowed || absorbed.has(u.element)) continue;
    const tag = u.element.tagName;
    const by = u.closedBy;
    let where = 'at the end of the file';
    if (by?.kind === 'start') where = `before <${by.name}> at ${at(ctx, by.offset)}`;
    else if (by) where = `before </${by.name}> at ${at(ctx, by.offset)}`;
    out.push({
      rule: 'style/explicit-end-tag',
      ...startTagSpan(u.element),
      message: `Close <${tag}> explicitly: add </${tag}> ${where}.`,
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
function attributes(ctx: RuleContext, element: Element): RawFinding[] {
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
    if (isHtml(element) && isBooleanAttribute(element.tagName, attr.name)) {
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
  const suffix = token.selfClosing ? /[\t\n\f\r ]*\/>$/.exec(tag)![0] : /[\t\n\f\r ]*>$/.exec(tag)![0];
  const style = ctx.options.voidElements;
  const wanted = style === 'xhtml' ? ' />' : style === 'tight' ? '/>' : '>';
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

