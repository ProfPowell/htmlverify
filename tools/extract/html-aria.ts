// Extracts the element table of ARIA in HTML (w3c/html-aria, index.html) into
// data/html-aria.json, pinned to the checkout's commit. The table is prose;
// src/spec/html-aria.ts encodes it, and data/html-aria-basis.json pins the
// text each entry was written against.
//
//   node tools/extract/html-aria.ts <w3c-html-aria-checkout> [out.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5';
import { stableJson } from './json.ts';

type Node = T.Node;
type Element = T.Element;

const [checkout, out = 'data/html-aria.json'] = process.argv.slice(2);
if (!checkout) {
  console.error('usage: node tools/extract/html-aria.ts <w3c-html-aria-checkout> [out.json]');
  process.exit(2);
}

const sourcePath = join(checkout, 'index.html');
const bytes = readFileSync(sourcePath);
const doc = parse(bytes.toString('utf8'));
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();

const isElement = (node: Node): node is Element => 'tagName' in node;
function* descendants(node: Node): Generator<Element> {
  for (const kid of 'childNodes' in node ? node.childNodes : []) {
    if (!isElement(kid)) continue;
    yield kid;
    yield* descendants(kid);
  }
}
const text = (node: Node): string =>
  node.nodeName === '#text' ? (node as T.TextNode).value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
const cellsOf = (row: Element) => row.childNodes.filter((n): n is Element => isElement(n) && (n.tagName === 'td' || n.tagName === 'th'));

const table = [...descendants(doc)].find((e) => e.tagName === 'table' && attr(e, 'class') === 'data');
if (!table) throw new Error('element table not found');

const rows: Record<string, unknown> = {};
for (const row of [...descendants(table)].filter((e) => e.tagName === 'tr')) {
  const [element, implicit, allowances] = cellsOf(row);
  const id = element && attr(element, 'id');
  if (!id || !implicit || !allowances) continue;
  const linked = (cell: Element, pattern: RegExp) =>
    [...new Set([...descendants(cell)].flatMap((e) => {
      const target = attr(e, 'href') ?? attr(e, 'data-cite') ?? '';
      const m = pattern.exec(target);
      return e.tagName === 'a' && m ? [m[1]!] : [];
    }))];
  const entry = {
    element: squash(text(element)),
    implicit: squash(text(implicit)),
    allowances: squash(text(allowances)),
    roles: linked(allowances, /^#index-aria-([a-z]+)$/),
    dpubRoles: linked(allowances, /#(doc-[a-z]+)$/),
  };
  rows[id] = { ...entry, parsed: parseRow(entry) };
}

/**
 * Reads the table's recurring phrasings. Conditional rows ("If …") come back
 * with conditional: true; src/spec/html-aria.ts encodes those by hand.
 */
function parseRow(row: { implicit: string; allowances: string; roles: string[]; dpubRoles: string[] }) {
  const a = row.allowances;
  const conditional = /^(?:If |No `role` if )|\. If the `[a-z]+` is /.test(a) || /\bif\b|Otherwise, role=/i.test(row.implicit);
  const implicit = /^No corresponding role/.test(row.implicit) ? null : (/^`?role=`?([a-z-]+)`?/.exec(row.implicit)?.[1] ?? null);
  let allowed: 'any' | string[];
  let discouraged: string[] = [];
  let m: RegExpExecArray | null;
  if (/^Any `role`/.test(a)) {
    allowed = 'any';
    m = /^Any `role`, though `?([a-z-]+)`? (?:is NOT RECOMMENDED|SHOULD NOT be used)/.exec(a);
    if (m) discouraged = [m[1]!];
  } else if ((m = /^No `role` other than (?:`?([a-z]+)`?(?: or `?([a-z]+)`?)?), which (?:is|are) NOT RECOMMENDED/.exec(a)) || (m = /^No `role` other than `?([a-z]+)`?, which SHOULD NOT be used/.exec(a))) {
    allowed = [m[1]!, ...(m[2] ? [m[2]] : [])];
    discouraged = [...allowed];
  } else if (/^No `role`/.test(a)) {
    allowed = [];
  } else if (/^The following roles are allowed, but are NOT RECOMMENDED/.test(a)) {
    allowed = [...row.roles];
    discouraged = [...row.roles];
  } else if (/^Roles?: /.test(a)) {
    allowed = [...row.roles];
    for (const n of a.matchAll(/\((?:role=)?([a-z]+)(?: or ([a-z]+))? (?:is|are) also allowed/g)) discouraged.push(n[1]!, ...(n[2] ? [n[2]] : []));
    for (const n of a.matchAll(/\(?(?:role=)?([a-z]+) (?:is also allowed, but )?SHOULD NOT be used/g)) discouraged.push(n[1]!);
  } else {
    allowed = [];
  }
  let aria: string | { role: string } | { extra: string[] };
  if (/^No `role` or `aria-\*` attributes|No `aria-\*` attributes\.$/.test(a)) aria = 'none';
  else if (/no other allowed `aria-\*` attributes|No `aria-\*` attributes except `aria-hidden="true"`/.test(a)) aria = 'hidden-only';
  else if ((m = /applicable to the `([a-z]+)`(?: or `([a-z]+)`)? role/.exec(a))) aria = { role: m[1]! };
  else if (/applicable to the allowed roles/.test(a)) aria = 'roles';
  else if ((m = /Global `aria-\*` attributes(?:,| and) ((?:`aria-[a-z]+`(?:,? and |, )?)+) attributes?/.exec(a))) aria = { extra: [...m[1]!.matchAll(/`(aria-[a-z]+)`/g)].map((x) => x[1]!) };
  else if (/global `aria-\*` attributes/i.test(a)) aria = 'global';
  else aria = 'none';
  const mentioned = (pattern: RegExp) => [...a.matchAll(pattern)].flatMap((x) => [...x[0].matchAll(/`(aria-[a-z]+)`/g)].map((y) => y[1]!));
  return {
    conditional,
    implicit,
    allowed: [...(allowed === 'any' ? ['*'] : allowed)],
    discouraged: [...new Set(discouraged)],
    aria,
    namingProhibited: /Naming Prohibited(?! if)/.test(a),
    mustNot: mentioned(/Authors MUST NOT use the (?:`aria-[a-z]+`(?: or )?)+ attributes?/g),
    shouldNot: mentioned(/Authors SHOULD NOT use the (?:`aria-[a-z]+`(?: or )?)+ attributes?/g),
  };
}

writeFileSync(out, stableJson({
  source: {
    repo: 'https://github.com/w3c/html-aria',
    commit: git('rev-parse', 'HEAD'),
    date: git('log', '-1', '--format=%cs'),
    file: 'index.html',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  },
  rows,
}));
console.log(`${out}: ${Object.keys(rows).length} rows`);
