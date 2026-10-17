import { treeSignature } from '../fix/equivalence.ts';
import { parseHtml } from '../parse/parse.ts';
import { isComment, isElement, isText, isWhitespaceText, walk } from '../parse/tree.ts';
import { words } from '../text.ts';
import type { Edit, RawFinding, RuleContext } from './types.ts';
import { locatedElements, readAttribute } from './util.ts';

/** Elements whose content keeps its whitespace; the rule leaves it alone (spec §6.2). */
const EXEMPT = new Set(['pre', 'textarea', 'listing', 'plaintext', 'xmp', 'script', 'style']);

/** Where a run of whitespace sits, which decides whether a fix may change it (spec §8). */
type Place = 'markup' | 'whitespace text' | 'text' | 'comment' | 'attribute value';
const PLURAL: Record<Place, string> = { markup: 'markup', 'whitespace text': 'whitespace', text: 'text', comment: 'comments', 'attribute value': 'attribute values' };

/** Sorted spans, merged where they overlap, with containment lookup. */
class Spans {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  constructor(spans: [number, number][]) {
    spans.sort((a, b) => a[0] - b[0]);
    for (const [start, end] of spans) {
      if (end <= start) continue;
      const last = this.ends.length - 1;
      if (last >= 0 && start <= this.ends[last]!) this.ends[last] = Math.max(this.ends[last]!, end);
      else {
        this.starts.push(start);
        this.ends.push(end);
      }
    }
  }

  /** Whether one span holds all of [start, end). */
  covers(start: number, end = start + 1): boolean {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= start) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && end <= this.ends[lo - 1]!;
  }
}

interface Segment {
  start: number;
  end: number;
  line: number;
  replacement: string;
  place: Place;
}

/**
 * style/whitespace (spec §6.2): tab indentation, trailing whitespace, and the
 * end of the file. A fix changes whitespace only where the tree can't see it:
 * inside tags, in whitespace-only text, and where the parser drops it.
 */
export function checkWhitespace(ctx: RuleContext): RawFinding[] {
  const text = ctx.text;
  if (text.length === 0) return [];
  const tabWidth = (ctx.ruleOptions['style/whitespace']?.['tabWidth'] as number | undefined) ?? 2;
  const place = places(ctx);

  // The end of the file, from the last non-whitespace character.
  let tailStart = text.length;
  while (tailStart > 0 && ' \t\r\n'.includes(text[tailStart - 1]!)) tailStart--;

  const tabs: Segment[] = [];
  const trailing: Segment[] = [];
  const breaks = /\r\n|\n|\r/g;
  for (let lineStart = 0, line = 1; lineStart < tailStart; line++) {
    breaks.lastIndex = lineStart;
    const m = breaks.exec(text);
    const lineEnd = Math.min(m ? m.index : text.length, tailStart);
    let lead = lineStart;
    while (lead < lineEnd && (text[lead] === ' ' || text[lead] === '\t')) lead++;
    let trail = lineEnd;
    while (trail > lead && (text[trail - 1] === ' ' || text[trail - 1] === '\t')) trail--;
    const add = (list: Segment[], start: number, end: number, replacement: string) => {
      const where = place(start, end);
      if (where) list.push({ start, end, line, replacement, place: where });
    };
    if (lead === lineEnd) {
      if (lineEnd > lineStart) add(trailing, lineStart, lineEnd, '');
    } else {
      if (text.slice(lineStart, lead).includes('\t')) add(tabs, lineStart, lead, expand(text.slice(lineStart, lead), tabWidth));
      if (trail < lineEnd) add(trailing, trail, lineEnd, '');
    }
    if (!m) break;
    lineStart = m.index + m[0].length;
  }

  const out: RawFinding[] = [];
  const report = (segments: Segment[], fixable: string, unfixable: (lines: string, where: string) => string) => {
    const auto: Segment[] = [];
    const manual: Segment[] = [];
    for (const s of segments) (s.place === 'markup' || s.place === 'whitespace text' ? auto : manual).push(s);
    if (auto.length > 0) {
      out.push({
        rule: 'style/whitespace',
        offset: auto[0]!.start,
        endOffset: auto[0]!.end,
        message: fixable.replace('{n}', `${auto.length} line${auto.length === 1 ? '' : 's'}`),
        fix: auto.map((s): Edit => ({ offset: s.start, endOffset: s.end, text: s.replacement })),
      });
    }
    if (manual.length > 0) {
      const lines = manual.map((s) => String(s.line));
      const list = lines.length > 5 ? `${lines.slice(0, 5).join(', ')}, and ${lines.length - 5} more` : words(lines, 'and');
      const where = words([...new Set(manual.map((s) => PLURAL[s.place]))], 'and');
      out.push({ rule: 'style/whitespace', offset: manual[0]!.start, endOffset: manual[0]!.end, message: unfixable(`line${lines.length === 1 ? '' : 's'} ${list}`, where) });
    }
  };
  report(tabs, 'Indent with spaces, not tabs ({n}).',
    (lines, where) => `Indent with spaces, not tabs, on ${lines}: the tabs are inside ${where}, which a fix won’t change, so edit them by hand.`);
  report(trailing, 'Remove the trailing whitespace ({n}).',
    (lines, where) => `Remove the trailing whitespace on ${lines}: it’s inside ${where}, which a fix won’t change, so edit it by hand.`);

  // A single line break ends the file, unless the end of the file is content:
  // the last text of a <p> left open, or a fragment for a phrasing context.
  const tail = text.slice(tailStart);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!/^(?:\r\n|\n|\r)$/.test(tail) && place(text.length - 1, text.length) !== null) {
    const fixed = text.slice(0, tailStart) + newline;
    if (treeSignature(parseHtml(fixed, ctx.parsed.context?.tagName ?? null)) === treeSignature(ctx.parsed)) {
      const count = tail.match(/\r\n|\n|\r/g)?.length ?? 0;
      out.push({
        rule: 'style/whitespace',
        offset: tailStart,
        endOffset: text.length,
        message: count === 0
          ? `${tail ? 'Remove the trailing whitespace and end' : 'End'} the file with a newline.`
          : count === 1 ? 'Remove the trailing whitespace at the end of the file.'
          : `End the file with a single newline; it ends with ${count - 1} blank line${count === 2 ? '' : 's'}.`,
        fix: [{ offset: tailStart, endOffset: text.length, text: newline }],
      });
    }
  }
  return out;
}

/** Expands tabs to the next multiple of `width`. */
function expand(indent: string, width: number): string {
  let out = '';
  for (const c of indent) out += c === '\t' ? ' '.repeat(width - (out.length % width)) : c;
  return out;
}

/** Classifies [start, end) by what holds it; null inside exempt elements. */
function places(ctx: RuleContext): (start: number, end: number) => Place | null {
  const exempt: [number, number][] = [];
  const values: [number, number][] = [];
  const markup: [number, number][] = ctx.parsed.tokens.filter((t) => t.offset >= 0).map((t) => [t.offset, t.endOffset]);
  const comments: [number, number][] = [];
  const texts: [number, number][] = [];
  const blanks: [number, number][] = [];
  if (ctx.parsed.context && EXEMPT.has(ctx.parsed.context.tagName)) exempt.push([0, ctx.text.length]);
  for (const { node } of walk(ctx.parsed.root)) {
    const loc = node.sourceCodeLocation;
    if (!loc) continue;
    if (isElement(node)) {
      const tags = node.sourceCodeLocation!;
      if (EXEMPT.has(node.tagName) && tags.startTag) exempt.push([tags.startTag.endOffset, tags.endTag?.startOffset ?? tags.endOffset]);
    } else if (isText(node)) {
      (isWhitespaceText(node) ? blanks : texts).push([loc.startOffset, loc.endOffset]);
    } else if (isComment(node)) {
      comments.push([loc.startOffset, loc.endOffset]);
    } else if (node.nodeName === '#documentType') {
      markup.push([loc.startOffset, loc.endOffset]);
    }
  }
  for (const element of locatedElements(ctx)) {
    for (const loc of Object.values(element.sourceCodeLocation!.attrs ?? {})) {
      const r = readAttribute(ctx.text, loc.startOffset);
      if (r.quote !== 'bare') values.push([r.valueOffset, r.valueEndOffset]);
    }
  }
  const spans = {
    exempt: new Spans(exempt), values: new Spans(values), markup: new Spans(markup),
    comments: new Spans(comments), texts: new Spans(texts), blanks: new Spans(blanks),
  };
  return (start, end) => {
    if (spans.exempt.covers(start)) return null;
    if (spans.values.covers(start)) return 'attribute value';
    if (spans.markup.covers(start, end)) return 'markup';
    if (spans.comments.covers(start)) return 'comment';
    if (spans.texts.covers(start) || spans.texts.covers(end - 1)) return 'text';
    if (spans.blanks.covers(start, end)) return 'whitespace text';
    // Partly in whitespace text: leave it to a person.
    if (spans.blanks.covers(start) || spans.blanks.covers(end - 1)) return 'text';
    // Whitespace the parser drops, such as before <html>.
    return 'markup';
  };
}
