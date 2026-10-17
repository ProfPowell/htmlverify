import { parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5';
import { isElement, isHtml, isText, walk, type Element } from '../parse/tree.ts';
import type { Edit, RawFinding, RuleContext } from './types.ts';
import { locatedElements, readAttribute } from './util.ts';

/** Elements whose text the tokenizer reads raw: no character references, no markup. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** Elements whose text decodes character references but can't hold markup. */
const RCDATA = new Set(['title', 'textarea']);
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * style/escape (spec §6.2): `&`, `<`, and `>` that HTML reads as literal
 * characters without a parse error, in text and (for `&`) attribute values.
 * Escaping them changes nothing in the tree.
 */
export function checkEscape(ctx: RuleContext, absorbed: ReadonlySet<Element>): RawFinding[] {
  const out: RawFinding[] = [];
  const literal = ampersandDecoder();
  const report = (edits: Edit[], message: string) => {
    if (edits.length > 0) out.push({ rule: 'style/escape', offset: edits[0]!.offset, endOffset: edits[0]!.endOffset, message, fix: edits });
  };
  const escape = (offset: number, char: string): Edit => ({ offset, endOffset: offset + 1, text: ENTITY[char]! });

  // Text. Tags the tree builder ignored can sit inside a text node's span.
  const tokens = ctx.parsed.tokens.filter((t) => t.offset >= 0);
  for (const { node, parent } of walk(ctx.parsed.root)) {
    if (!isText(node) || !node.sourceCodeLocation || !parent) continue;
    // Text at a fragment's top level is tokenized as its context element's.
    const owner = isElement(parent) ? parent : ctx.parsed.context;
    if (owner && ((isHtml(owner) && RAW_TEXT.has(owner.tagName)) || owner.tagName === 'script' || owner.tagName === 'style')) continue;
    const rcdata = owner !== null && isHtml(owner) && RCDATA.has(owner.tagName);
    // A self-closed <textarea/> or <title/> swallows the markup after it: syntax explains that.
    if (rcdata && absorbed.has(owner)) continue;
    const { startOffset, endOffset } = node.sourceCodeLocation;
    const raw = ctx.text.slice(startOffset, endOffset);
    if (!/[&<>]/.test(raw) || raw.includes('<![CDATA[')) continue;
    const edits: Edit[] = [];
    let t = lowerBound(tokens, startOffset);
    for (let i = 0; i < raw.length; i++) {
      const offset = startOffset + i;
      while (t < tokens.length && tokens[t]!.endOffset <= offset) t++;
      if (t < tokens.length && tokens[t]!.offset <= offset) {
        i = tokens[t]!.endOffset - startOffset - 1;
        continue;
      }
      const c = raw[i]!;
      // In ordinary text a bare `<` is a parse error, which syntax/parse-error reports.
      if (c === '>' || (c === '<' && rcdata) || (c === '&' && literal(raw, i, 'text'))) edits.push(escape(offset, c));
    }
    const chars = [...new Set(edits.map((e) => ctx.text[e.offset]!))];
    report(edits, `Escape ${chars.map((c) => `${c} as ${ENTITY[c]}`).join(' and ')} in text.`);
  }

  // Attribute values: only `&` is ambiguous there.
  for (const element of locatedElements(ctx)) {
    const locs = element.sourceCodeLocation!.attrs ?? {};
    for (const attr of element.attrs) {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      const loc = locs[name.toLowerCase()];
      if (!loc || !attr.value.includes('&')) continue;
      const r = readAttribute(ctx.text, loc.startOffset);
      if (r.quote === 'bare') continue;
      const raw = ctx.text.slice(r.valueOffset, r.valueEndOffset);
      const edits: Edit[] = [];
      for (let i = raw.indexOf('&'); i !== -1; i = raw.indexOf('&', i + 1)) {
        if (literal(raw, i, 'attribute')) edits.push(escape(r.valueOffset + i, '&'));
      }
      report(edits, `Escape & as &amp; in ${name}.`);
    }
  }
  return out;
}

/** Index of the first token ending after `offset`. */
function lowerBound(tokens: readonly { endOffset: number }[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid]!.endOffset <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether the `&` at `i` is a literal character that HTML accepts without a
 * parse error. The tokenizer decides from the characters after it alone
 * (alphanumerics, `#`, `;`, and in attributes a following `=`), so parsing
 * that snippet by itself gives the same answer as the whole document.
 */
function ampersandDecoder(): (source: string, i: number, where: 'text' | 'attribute') => boolean {
  const cache = new Map<string, boolean>();
  return (source, i, where) => {
    const run = /^[#0-9A-Za-z]*(;|=?)/.exec(source.slice(i + 1, i + 80))![0];
    const snippet = `&${where === 'text' ? run.replace(/=$/, '') : run}`;
    if (snippet === '&') return true;
    const key = `${where}\0${snippet}`;
    let answer = cache.get(key);
    if (answer === undefined) {
      let errors = 0;
      const fragment = parseFragment(where === 'text' ? `<i>${snippet}</i>` : `<i title="${snippet}"></i>`, { onParseError: () => errors++ });
      const i = fragment.childNodes[0] as T.Element;
      const decoded = where === 'text' ? ((i.childNodes[0] as T.TextNode | undefined)?.value ?? '') : (i.attrs[0]?.value ?? '');
      answer = errors === 0 && decoded === snippet;
      cache.set(key, answer);
    }
    return answer;
  };
}
