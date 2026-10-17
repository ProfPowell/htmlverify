// Restricted HTML (spec §9.5, §9.6): inline and prose parameters, and HTML
// nodes, parsed where they're inserted and validated, never sanitized.
// Nothing is silently dropped: anything outside the allowlist, a parse
// repair, or a strict error fails assembly, located inside the value.

import { LineIndex } from '../parse/lines.ts';
import { parseHtml } from '../parse/parse.ts';
import { childrenOf, isComment, isElement, isHtml, walk, type ChildNode, type Element } from '../parse/tree.ts';
import { check, type CheckOptions } from '../report/report.ts';
import { tags } from '../text.ts';
import { validateValue, type Problem, type ValueOptions } from './params.ts';

const INLINE: Record<string, readonly string[]> = {
  a: ['href', 'hreflang'], abbr: ['title'], b: [], bdi: [], br: [], cite: [], code: [], data: ['value'], del: [], dfn: [], em: [], i: [], ins: [],
  kbd: [], mark: [], q: ['cite'], s: [], samp: [], small: [], span: [], strong: [], sub: [], sup: [], time: ['datetime'], u: [], var: [], wbr: [],
};
const PROSE: Record<string, readonly string[]> = {
  ...INLINE, p: [], ul: [], ol: ['start', 'reversed'], li: [], dl: [], dt: [], dd: [], blockquote: ['cite'], pre: [], hr: [],
  h2: [], h3: [], h4: [], h5: [], h6: [],
};
const GLOBAL = ['lang', 'dir', 'title'];
const URLS = new Set(['href', 'cite']);

export interface RestrictedValue {
  nodes: ChildNode[];
  /** Prose headings with their level relative to the highest one (0 for it). */
  headings: { element: Element; relative: number }[];
  /** Each problem's position is inside the value: "1:5". */
  problems: Problem[];
}

/**
 * Parses an inline or prose value, or an HTML node, in its insertion context
 * and validates it. `pointer` locates the value in the plan.
 */
export async function parseRestricted(
  value: string, kind: 'inline' | 'prose' | 'html', context: string, pointer: string,
  options: { values: ValueOptions; check: CheckOptions },
): Promise<RestrictedValue> {
  const problems: Problem[] = [];
  const lines = new LineIndex(value);
  const here = (offset: number) => {
    const p = lines.position(offset);
    return `${p.line}:${p.column}`;
  };
  const problem = (offset: number, message: string) => problems.push({ pointer, message: `${here(offset)} ${message}` });
  const parsed = parseHtml(value, context);
  /** Start tags already reported, so strict doesn't report the same element again. */
  const reported: { start: number; end: number }[] = [];
  const flag = (node: Element) => {
    const tag = node.sourceCodeLocation?.startTag;
    if (tag) reported.push({ start: tag.startOffset, end: tag.endOffset });
  };
  const nodes = [...childrenOf(parsed.root)];
  const allowed = kind === 'inline' ? INLINE : kind === 'prose' ? PROSE : null;
  const label = kind === 'html' ? 'an HTML node' : `${kind === 'inline' ? 'an inline' : 'a prose'} value`;

  for (const { node } of walk(parsed.root)) {
    const offset = (node as { sourceCodeLocation?: { startOffset: number } | null }).sourceCodeLocation?.startOffset ?? 0;
    if (isComment(node)) {
      if (allowed) problem(offset, `Comments aren’t allowed in ${label}.`);
      continue;
    }
    if (!isElement(node) || node === parsed.root) continue;
    const tag = node.tagName;
    const attrOffset = (name: string) => node.sourceCodeLocation?.attrs?.[name]?.startOffset ?? offset;
    if (allowed) {
      const attributes = isHtml(node) ? allowed[tag] : undefined;
      if (!attributes) {
        problem(offset, `<${tag}> isn’t allowed in ${label}; it takes ${tags(Object.keys(allowed), 'and')}.`);
        flag(node);
        continue;
      }
      for (const a of node.attrs) {
        if (!attributes.includes(a.name) && !GLOBAL.includes(a.name)) {
          problem(attrOffset(a.name), `${a.name} isn’t allowed on <${tag}> in ${label}${attributes.length ? `; it takes ${[...attributes, ...GLOBAL].join(', ')}` : ''}.`);
          flag(node);
        } else if (URLS.has(a.name)) {
          const urlProblems: Problem[] = [];
          validateValue({ type: 'url', required: true }, a.value, '', urlProblems, options.values);
          for (const p of urlProblems) problem(attrOffset(a.name), `${a.name}="${a.value}" ${p.message}.`);
          if (urlProblems.length) flag(node);
        }
      }
    } else {
      if (isHtml(node) && (tag === 'script' || tag === 'style')) {
        problem(offset, `<${tag}> isn’t allowed in an HTML node.`);
        flag(node);
      }
      for (const a of node.attrs) {
        if (!a.name.startsWith('on')) continue;
        problem(attrOffset(a.name), `${a.name} isn’t allowed in an HTML node; event handlers belong in scripts.`);
        flag(node);
      }
    }
  }

  // Parse repairs and everything else strict reports, apart from what's above.
  const [report] = (await check({ path: 'value.html', source: value, context }, { ...options.check, profile: 'strict' })).files;
  for (const f of report!.findings) {
    if (f.severity !== 'error' || reported.some((r) => r.start <= f.offset && f.offset < r.end)) continue;
    problem(f.offset, `${f.message} (${f.rule})`);
  }

  const headings: RestrictedValue['headings'] = [];
  if (kind === 'prose') {
    const found = [...walk(parsed.root)].map(({ node }) => node).filter((n): n is Element => isElement(n) && /^h[2-6]$/.test(n.tagName));
    const top = Math.min(...found.map((h) => Number(h.tagName[1])));
    let previous = -1;
    for (const h of found) {
      const relative = Number(h.tagName[1]) - top;
      if (relative > previous + 1) {
        problem(h.sourceCodeLocation?.startOffset ?? 0, `<${h.tagName}> skips a level; prose headings are relative, so start with the highest and go down one at a time.`);
      }
      previous = relative;
      headings.push({ element: h, relative });
    }
  }
  return { nodes, headings, problems };
}
