import { OPTIONAL_START_TAGS, VOID_ELEMENTS } from '../spec/html.ts';
import type { TagToken } from '../parse/parse.ts';
import type { Unclosed } from '../parse/reconcile.ts';
import { childrenOf, isElement, isHtml, startOf, type Document, type Element } from '../parse/tree.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { at, describe, htmlName, locatedElements, openElementAt, readAttribute, startTagSpan } from './util.ts';

export interface SyntaxResult {
  findings: RawFinding[];
  /** Elements whose missing end tag a syntax finding already explains. */
  absorbed: Set<Element>;
}

/** Doctype problems, reported once as syntax/doctype. */
const DOCTYPE_CODES = new Set([
  'missing-doctype', 'non-conforming-doctype', 'misplaced-doctype', 'eof-in-doctype',
  'missing-whitespace-after-doctype-public-keyword', 'missing-whitespace-between-doctype-public-and-system-identifiers',
  'missing-whitespace-after-doctype-system-keyword', 'missing-quote-before-doctype-public-identifier',
  'missing-quote-before-doctype-system-identifier', 'missing-doctype-public-identifier',
  'missing-doctype-system-identifier', 'abrupt-doctype-public-identifier', 'abrupt-doctype-system-identifier',
  'missing-whitespace-before-doctype-name', 'missing-doctype-name', 'invalid-character-sequence-after-doctype-name',
  'unexpected-character-after-doctype-system-identifier',
]);

/** Tree-construction errors that reconciliation reports with its own cause. */
const RECONCILED_CODES = new Set([
  'end-tag-without-matching-open-element', 'closing-of-element-with-open-child-elements', 'open-elements-left-after-eof',
  'abandoned-head-element-child', 'misplaced-start-tag-for-head-element', 'eof-in-element-that-can-contain-only-text',
]);

const SELF_CLOSING_CODE = 'non-void-html-element-start-tag-with-trailing-solidus';

export const PARSE_ERROR_MESSAGES: Record<string, string> = {
  'control-character-in-input-stream': 'Control character in the input; remove it.',
  'noncharacter-in-input-stream': 'Unicode noncharacter in the input; remove it.',
  'surrogate-in-input-stream': 'Lone surrogate in the input; remove it.',
  'unexpected-null-character': 'NUL character in the input; remove it.',
  'end-tag-with-attributes': 'End tags can’t have attributes; move them to the start tag.',
  'end-tag-with-trailing-solidus': 'End tags can’t end with "/>"; write ">".',
  'unexpected-solidus-in-tag': 'Stray "/" inside a tag; remove it.',
  'unexpected-question-mark-instead-of-tag-name': '"<?" starts a bogus comment in HTML; remove XML processing instructions such as <?xml …?>.',
  'invalid-first-character-of-tag-name': '"<" isn’t followed by a tag name, so it’s text; write &lt; for a literal "<".',
  'unexpected-equals-sign-before-attribute-name': 'An attribute name can’t start with "="; check for a missing name or a stray "=".',
  'missing-end-tag-name': '"</>" is ignored; write the name in the end tag.',
  'unexpected-character-in-attribute-name': 'An attribute name contains ", \', or <; check for a missing quote or space.',
  'unknown-named-character-reference': 'Unknown character reference; write &amp; for a literal "&".',
  'missing-semicolon-after-character-reference': 'Character reference without ";"; add the semicolon.',
  'unexpected-character-in-unquoted-attribute-value': 'An unquoted value contains ", \', <, =, or `; quote the value.',
  'eof-before-tag-name': 'The file ends right after "<".',
  'eof-in-tag': 'The file ends inside a tag; finish it with ">".',
  'missing-attribute-value': 'An attribute has "=" but no value; write name="".',
  'missing-whitespace-between-attributes': 'Attributes must be separated by whitespace.',
  'cdata-in-html-content': 'CDATA sections only work inside SVG and MathML; here it becomes a bogus comment.',
  'incorrectly-opened-comment': 'Malformed comment: comments start with "<!--".',
  'eof-in-script-html-comment-like-text': 'The file ends inside "<!--" text in a script.',
  'nested-comment': '"<!--" inside a comment.',
  'abrupt-closing-of-empty-comment': '"<!-->" or "<!--->" closes the comment immediately; write "<!-- -->".',
  'eof-in-comment': 'The file ends inside a comment; close it with "-->".',
  'incorrectly-closed-comment': 'Comment closed with "--!>"; write "-->".',
  'eof-in-cdata': 'The file ends inside a CDATA section.',
  'absence-of-digits-in-numeric-character-reference': '"&#" without digits; write &amp;# for a literal.',
  'null-character-reference': '&#0; isn’t allowed.',
  'surrogate-character-reference': 'Character reference to a surrogate code point.',
  'character-reference-outside-unicode-range': 'Character reference beyond U+10FFFF.',
  'control-character-reference': 'Character reference to a control character.',
  'noncharacter-character-reference': 'Character reference to a Unicode noncharacter.',
  'disallowed-content-in-noscript-in-head': 'A <noscript> inside <head> can only contain <link>, <meta>, and <style>.',
  'nested-noscript-in-head': '<noscript> can’t be nested inside <noscript> in <head>.',
};

export function checkSyntax(ctx: RuleContext): SyntaxResult {
  const { parsed, signals, text } = ctx;
  const findings: RawFinding[] = [];
  const absorbed = new Set<Element>();
  const claimed = new Set<number>();
  const unclosedOf = new Map(signals.unclosed.map((u) => [u.element, u]));
  const elementAt = new Map<number, Element>();
  for (const [element, token] of signals.startToken) if (!elementAt.has(token.offset)) elementAt.set(token.offset, element);
  const until = (u: Unclosed | undefined) =>
    !u || u.closedAt >= text.length ? 'the end of the file' : at(ctx, u.closedAt);

  // `/>` on a non-void element: the slash is ignored and the element stays open.
  for (const e of parsed.errors) {
    if (e.code !== SELF_CLOSING_CODE) continue;
    const element = elementAt.get(e.offset);
    if (!element) continue;
    claimed.add(e.offset);
    absorbed.add(element);
    const tag = element.tagName;
    const endTag = element.sourceCodeLocation?.endTag;
    const upTo = endTag ? `</${tag}> at ${at(ctx, endTag.startOffset)}` : until(unclosedOf.get(element));
    const closer = endTag?.startOffset ?? unclosedOf.get(element)?.closedBy?.offset;
    findings.push({
      rule: 'syntax/self-closing-non-void',
      ...startTagSpan(element),
      message: `<${tag}/> doesn’t close the element: HTML ignores "/" on non-void elements, so <${tag}> stays open and swallows everything up to ${upTo}. Write <${tag}></${tag}>.`,
      evidence: { element: tag },
      ...(closer === undefined ? {} : { alsoAt: [closer] }),
    });
  }

  // Formatting elements the adoption agency split into clones.
  for (const group of signals.clones) {
    const original = group[0]!;
    for (const element of group) absorbed.add(element);
    const closer = unclosedOf.get(original)?.closedBy;
    const tag = original.tagName;
    const closerTag = closer ? `<${closer.kind === 'end' ? '/' : ''}${closer.name}>` : 'that end tag';
    const where = closer ? `${closerTag} at ${at(ctx, closer.offset)}` : 'a later end tag';
    findings.push({
      rule: 'syntax/misnested',
      ...startTagSpan(original),
      message: `<${tag}> overlaps ${where}: the parser closes it there and reopens it, making ${group.length} <${tag}> elements. Close </${tag}> before ${closerTag}.`,
      evidence: { element: tag, elements: group.length },
      ...(closer ? { alsoAt: [closer.offset] } : {}),
    });
  }

  // End tags that close nothing. An earlier element of the same name that the
  // parser closed implicitly usually explains them.
  for (const token of signals.strayEnd) {
    claimed.add(token.offset);
    const earlier = closedEarlier(ctx, token);
    const by = earlier?.closedBy;
    // `<b><i>…</b></i>`: an ancestor's end tag closed the element, so its own end tag matches nothing.
    if (earlier && by?.kind === 'end' && by.name !== token.name && !absorbed.has(earlier.element)) {
      absorbed.add(earlier.element);
      const tag = token.name;
      const inserted = tag === 'p' ? ' The parser inserted an empty <p> there.' : '';
      findings.push({
        rule: 'syntax/misnested',
        ...startTagSpan(earlier.element),
        message: `<${tag}> overlaps </${by.name}> at ${at(ctx, by.offset)}: the parser closes it there, so </${tag}> at ${at(ctx, token.offset)} matches nothing.${inserted} Close </${tag}> before </${by.name}>.`,
        evidence: { element: tag, elements: 1 },
        alsoAt: [by.offset, token.offset],
      });
      continue;
    }
    findings.push({
      rule: 'syntax/stray-end-tag',
      offset: token.offset,
      endOffset: token.endOffset,
      message: strayMessage(ctx, token, absorbed, earlier),
      evidence: { element: token.name },
    });
  }

  // Missing end tags the optional-tag rules don't allow.
  for (const u of signals.unclosed) {
    if (u.omissionAllowed || absorbed.has(u.element)) continue;
    const tag = u.element.tagName;
    const by = u.closedBy;
    let how = 'it runs to the end of the file';
    if (by?.kind === 'start') how = `the parser closed it at ${at(ctx, by.offset)} when <${by.name}> began`;
    else if (by) how = `the parser closed it at </${by.name}> (${at(ctx, by.offset)})`;
    findings.push({
      rule: 'syntax/unclosed-element',
      ...startTagSpan(u.element),
      message: `<${tag}> is never closed: ${how}. Add </${tag}> where it should end.`,
      evidence: { element: tag },
      ...(by ? { alsoAt: [by.offset] } : {}),
    });
  }

  // Elements the parser had to imply around a misplaced start tag (a `td` directly in `table`).
  for (const element of signals.implied) {
    const tag = element.tagName;
    if (OPTIONAL_START_TAGS.has(tag)) continue;
    const kids = childrenOf(element);
    if ((tag === 'p' || tag === 'br') && kids.length === 0) continue;
    const child = kids.find((k) => isElement(k) && signals.startToken.has(k)) as Element | undefined;
    if (!child) continue;
    const token = signals.startToken.get(child)!;
    claimed.add(token.offset);
    const container = locatedAncestor(ctx, element) ?? 'its parent';
    findings.push({
      rule: 'syntax/misplaced-start-tag',
      offset: token.offset,
      endOffset: token.endOffset,
      message: `<${child.tagName}> can’t appear directly inside <${container}>: the parser wrapped it in an implied <${tag}>. Write the <${tag}> explicitly.`,
      evidence: { element: child.tagName, implied: tag },
    });
  }

  // Start tags the parser dropped.
  for (const token of signals.droppedStart) {
    claimed.add(token.offset);
    const open = htmlName(openElementAt(ctx, token.offset)) ?? htmlName(parsed.context);
    let why = open ? `it isn’t allowed inside <${open}>` : 'it isn’t allowed here';
    if (token.name === 'html' || token.name === 'body') why = `a document has one <${token.name}>, so the parser merged this tag’s attributes into the first and dropped it`;
    else if (token.name === 'head') why = 'a document has one <head>';
    else if (token.name === 'form') why = 'a <form> can’t contain another <form>';
    findings.push({
      rule: 'syntax/misplaced-start-tag',
      offset: token.offset,
      endOffset: token.endOffset,
      message: `The parser ignored <${token.name}>: ${why}.`,
      evidence: { element: token.name },
    });
  }

  // Content the parser moved: foster parenting, or content outside its parent's tags.
  for (const m of signals.moved) {
    if (isElement(m.node) && absorbed.has(m.node)) continue;
    const what = isElement(m.node) ? describe(m.node) : `text "${ctx.text.slice(m.offset, m.endOffset).replace(/\s+/g, ' ').slice(0, 24)}"`;
    let message: string;
    if (m.before && isElement(m.before) && m.before.tagName === 'table') {
      message = `${capitalize(what)} sits inside a <table> but outside any cell, so the parser moved it before the table. Put it in a cell or caption, or move it out of the table.`;
    } else if (m.before) {
      message = `The parser moved ${what} before ${describe(m.before)} at ${at(ctx, startOf(m.before)!)}.`;
    } else {
      const tag = m.into!.tagName;
      message = `${capitalize(what)} is outside <${tag}> in the source, so the parser moved it into <${tag}>. Put it inside <${tag}>…</${tag}>.`;
    }
    findings.push({ rule: 'syntax/reordered', offset: m.offset, endOffset: m.endOffset, message, evidence: { node: what } });
  }

  if (parsed.kind === 'document') {
    const doctype = checkDoctype(ctx);
    if (doctype) findings.push(doctype);
    findings.push(...checkCharset(ctx));
  }

  // Remaining parser errors, with plain-language messages.
  const rawTextUnclosed = signals.unclosed.some((u) => !u.closedBy);
  for (const e of parsed.errors) {
    if (e.code === SELF_CLOSING_CODE || DOCTYPE_CODES.has(e.code) || claimed.has(e.offset)) continue;
    if (RECONCILED_CODES.has(e.code) && (e.code !== 'eof-in-element-that-can-contain-only-text' || rawTextUnclosed)) continue;
    if (e.code === 'duplicate-attribute') {
      findings.push(duplicateAttribute(ctx, e.offset));
      continue;
    }
    findings.push({
      rule: 'syntax/parse-error',
      offset: e.offset,
      endOffset: Math.max(e.endOffset, e.offset),
      message: PARSE_ERROR_MESSAGES[e.code] ?? `Parse error: ${e.code}.`,
      evidence: { code: e.code },
    });
  }

  return { findings, absorbed };
}

/** The latest element named like a stray end tag that the parser closed before it. */
function closedEarlier(ctx: RuleContext, token: TagToken): Unclosed | null {
  let earlier: Unclosed | null = null;
  for (const u of ctx.signals.unclosed) {
    if (u.element.tagName === token.name && isHtml(u.element) && u.closedAt <= token.offset && (!earlier || u.closedAt > earlier.closedAt)) earlier = u;
  }
  return earlier;
}

function strayMessage(ctx: RuleContext, token: TagToken, absorbed: Set<Element>, earlier: Unclosed | null): string {
  const name = token.name;
  if (name === 'br') {
    const br = ctx.options.voidElements === 'html' ? '<br>' : ctx.options.voidElements === 'tight' ? '<br/>' : '<br />';
    return `</br> isn’t an end tag in HTML: the parser turns it into a <br>. Delete it, or write ${br} for a line break.`;
  }
  if (VOID_ELEMENTS.has(name)) return `<${name}> is a void element and never has an end tag; delete </${name}>.`;
  const inserted = name === 'p' ? ' The parser inserted an empty <p> here.' : '';
  if (!earlier) {
    let closed: Element | null = null;
    for (const element of locatedElements(ctx)) {
      const end = element.sourceCodeLocation?.endTag;
      if (element.tagName === name && isHtml(element) && end && end.startOffset < token.offset) closed = element;
    }
    const endTag = closed?.sourceCodeLocation?.endTag;
    if (closed && endTag) {
      return `</${name}> matches nothing: the <${name}> from ${at(ctx, startOf(closed)!)} was already closed by </${name}> at ${at(ctx, endTag.startOffset)}. Delete one of them.`;
    }
    return `</${name}> has no matching <${name}>; delete it.${inserted}`;
  }
  // A permitted omission explains the stray tag, so its style finding is redundant.
  if (earlier.omissionAllowed) absorbed.add(earlier.element);
  const by = earlier.closedBy;
  const when = by?.kind === 'start' ? ` when <${by.name}> began, because <${name}> can’t contain it` : by ? ` at </${by.name}>` : '';
  return `</${name}> matches nothing: the <${name}> from ${at(ctx, startOf(earlier.element)!)} was already closed at ${at(ctx, earlier.closedAt)}${when}.${inserted}`;
}

function checkDoctype(ctx: RuleContext): RawFinding | null {
  const doc = ctx.parsed.root as Document;
  const codes = ctx.parsed.errors.filter((e) => DOCTYPE_CODES.has(e.code));
  if (codes.length === 0 && doc.mode === 'no-quirks') return null;
  const has = (code: string) => codes.find((e) => e.code === code);
  const node = doc.childNodes.find((n) => n.nodeName === '#documentType');
  const evidence = { mode: doc.mode };
  if (has('missing-doctype')) {
    return { rule: 'syntax/doctype', offset: 0, endOffset: 0, evidence, message: 'No doctype, so the page renders in quirks mode. Start the file with <!doctype html>.' };
  }
  const misplaced = has('misplaced-doctype');
  if (misplaced) {
    return { rule: 'syntax/doctype', offset: misplaced.offset, endOffset: misplaced.endOffset, evidence, message: 'The doctype must come first; the parser ignored this one. Move <!doctype html> to the top.' };
  }
  const span = node?.sourceCodeLocation ?? { startOffset: 0, endOffset: 0 };
  const message = doc.mode === 'no-quirks'
    ? 'This doctype is obsolete or malformed. Use <!doctype html>.'
    : `This doctype puts the page in ${doc.mode} mode. Use <!doctype html>.`;
  return { rule: 'syntax/doctype', offset: span.startOffset, endOffset: span.endOffset, evidence, message };
}

function checkCharset(ctx: RuleContext): RawFinding[] {
  let meta: Element | null = null;
  let value = '';
  for (const element of locatedElements(ctx)) {
    if (element.tagName !== 'meta' || !isHtml(element)) continue;
    const charset = element.attrs.find((a) => a.name === 'charset');
    const equiv = element.attrs.find((a) => a.name === 'http-equiv' && a.value.toLowerCase() === 'content-type');
    const content = element.attrs.find((a) => a.name === 'content')?.value ?? '';
    if (charset) value = charset.value;
    else if (equiv) value = /charset\s*=\s*["']?([^"';\s]+)/i.exec(content)?.[1] ?? '';
    else continue;
    meta = element;
    break;
  }
  if (!meta) {
    if (ctx.bom) return [];
    return [{
      rule: 'syntax/encoding',
      offset: 0,
      endOffset: 0,
      message: 'No character encoding declaration. Add <meta charset="utf-8" /> as the first element in <head>.',
    }];
  }
  const out: RawFinding[] = [];
  const span = startTagSpan(meta);
  if (value.trim().toLowerCase() !== 'utf-8') {
    out.push({ rule: 'syntax/encoding', ...span, message: `The page declares "${value}"; HTML requires UTF-8. Write <meta charset="utf-8" />.`, evidence: { charset: value } });
  }
  const endByte = new TextEncoder().encode(ctx.text.slice(0, span.endOffset)).length + (ctx.bom ? 3 : 0);
  if (endByte > 1024) {
    out.push({ rule: 'syntax/encoding', ...span, message: `The charset declaration ends at byte ${endByte}; it must be within the first 1024 bytes. Move it to the top of <head>.`, evidence: { endByte } });
  }
  return out;
}

function duplicateAttribute(ctx: RuleContext, offset: number): RawFinding {
  // parse5 reports this error where the duplicate's name ends.
  let start = offset;
  while (start > 0 && !/[\t\n\f\r "'/<>=]/.test(ctx.text[start - 1]!)) start--;
  const owner = openElementAt(ctx, start);
  const raw = readAttribute(ctx.text, start);
  const name = raw.name.toLowerCase();
  const kept = owner?.attrs.find((a) => a.name === name);
  return {
    rule: 'syntax/duplicate-attribute',
    offset: start,
    endOffset: raw.endOffset,
    message: `Duplicate ${name} attribute: the parser keeps the first${kept ? ` (${name}="${kept.value}")` : ''} and drops this one. Merge them into one attribute.`,
    evidence: { attribute: name, dropped: raw.quote === 'bare' ? '' : ctx.text.slice(raw.valueOffset, raw.valueEndOffset) },
  };
}

function locatedAncestor(ctx: RuleContext, element: Element): string | null {
  let node = ctx.signals.parentOf.get(element);
  while (node) {
    if (isElement(node) && node.sourceCodeLocation) return node.tagName;
    node = ctx.signals.parentOf.get(node);
  }
  return htmlName(ctx.parsed.context);
}

function capitalize(s: string): string {
  return s.startsWith('<') ? s : s[0]!.toUpperCase() + s.slice(1);
}
