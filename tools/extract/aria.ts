// Extracts roles, states, and properties from a w3c/aria checkout (the
// WAI-ARIA editor's draft, index.html) into data/aria.json, pinned to the
// checkout's commit.
//
//   node tools/extract/aria.ts <w3c-aria-checkout> [out.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5';
import { stableJson } from './json.ts';

type Node = T.Node;
type Element = T.Element;

const [checkout, out = 'data/aria.json'] = process.argv.slice(2);
if (!checkout) {
  console.error('usage: node tools/extract/aria.ts <w3c-aria-checkout> [out.json]');
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
const hasClass = (e: Element, name: string) => (attr(e, 'class') ?? '').split(/\s+/).includes(name);
const byClass = (root: Element, name: string) => [...descendants(root)].find((e) => hasClass(e, name)) ?? null;
/** Names in <rref>, <sref>, and <pref> references. */
const refs = (cell: Element | null, tag?: string) =>
  cell ? [...descendants(cell)].filter((e) => (tag ? e.tagName === tag : /^[rsp]ref$/.test(e.tagName))).map((e) => squash(text(e))) : [];

const VALUE_TYPES: Record<string, string> = {
  'valuetype_true-false': 'true/false',
  valuetype_tristate: 'tristate',
  'valuetype_true-false-undefined': 'true/false/undefined',
  valuetype_idref: 'ID reference',
  valuetype_idref_list: 'ID reference list',
  valuetype_integer: 'integer',
  valuetype_number: 'number',
  valuetype_string: 'string',
  valuetype_token: 'token',
  valuetype_token_list: 'token list',
};

const GLOBAL: Record<string, string> = {
  'All elements of the base markup': 'yes',
  'All elements of the base markup except for some roles or elements that prohibit its use': 'unless prohibited',
  'Use as a global deprecated in ARIA 1.2': 'deprecated',
};

// Roles.
const roles: Record<string, unknown> = {};
for (const div of descendants(doc)) {
  if (div.tagName !== 'div' || !hasClass(div, 'role')) continue;
  const name = squash(text([...descendants(div)].find((e) => e.tagName === 'rdef')!));
  const cell = (cls: string) => byClass(div, cls);
  const flag = (cls: string) => squash(text(cell(cls) ?? div.childNodes[0]!)) === 'True';
  const listed = (cls: string) => {
    const c = cell(cls);
    if (!c) return [];
    const items = [...descendants(c)].filter((e) => e.tagName === 'li');
    return (items.length ? items : [c]).map((li) => squash(text(li))).filter(Boolean);
  };
  const conditions: Record<string, string> = {};
  for (const cls of ['role-required-properties', 'role-properties']) {
    const c = cell(cls);
    if (!c) continue;
    for (const ref of [...descendants(c)].filter((e) => e.tagName === 'pref' || e.tagName === 'sref')) {
      const after = ref.parentNode?.childNodes[ref.parentNode.childNodes.indexOf(ref) + 1];
      const note = after && after.nodeName === '#text' ? squash((after as T.TextNode).value) : '';
      if (note.startsWith('(')) conditions[squash(text(ref))] = note.replace(/^\(|\)$/g, '');
    }
  }
  const description = byClass(div, 'role-description');
  // "See synonym image": a role with no characteristics of its own takes its synonym's.
  const synonym = description ? [...descendants(description)].find((e) => {
    if (e.tagName !== 'rref' || !e.parentNode) return false;
    const before = e.parentNode.childNodes[e.parentNode.childNodes.indexOf(e) - 1];
    return before?.nodeName === '#text' && /See synonym\s*$/.test((before as T.TextNode).value);
  }) : undefined;
  roles[name] = {
    synonym: synonym ? squash(text(synonym)) : null,
    defined: cell('role-abstract') !== null,
    abstract: flag('role-abstract'),
    superclasses: refs(cell('role-parent'), 'rref'),
    required: refs(cell('role-required-properties')),
    supported: refs(cell('role-properties')),
    prohibited: refs(cell('role-disallowed')),
    conditions,
    nameFrom: listed('role-namefrom').flatMap((v) => v.split(/[\s,]+/)).filter(Boolean),
    nameRequired: flag('role-namerequired'),
    childrenPresentational: flag('role-childpresentational'),
    requiredParents: refs(cell('role-scope'), 'rref'),
    allowedChildren: refs(cell('role-mustcontain'), 'rref'),
    deprecated: hasClass(div, 'deprecated') || (description !== null && /\btreat \S+ as deprecated\b/.test(squash(text(description)))),
    implicitValues: squash(text(cell('implicit-values') ?? div.childNodes[0]!)),
  };
}

// States and properties.
const attributes: Record<string, unknown> = {};
for (const div of descendants(doc)) {
  if (div.tagName !== 'div' || !(hasClass(div, 'state') || hasClass(div, 'property'))) continue;
  const kind = hasClass(div, 'state') ? 'state' : 'property';
  const def = [...descendants(div)].find((e) => e.tagName === 'sdef' || e.tagName === 'pdef');
  if (!def) continue;
  const name = squash(text(def));
  // aria-current's value cell is classed property-value.
  const valueCell = byClass(div, 'state-value') ?? byClass(div, 'property-value');
  const href = valueCell ? [...descendants(valueCell)].find((e) => e.tagName === 'a')?.attrs.find((a) => a.name === 'href')?.value : undefined;
  const value = (href && VALUE_TYPES[href.replace(/^#/, '')]) ?? squash(text(valueCell ?? def));
  const values: string[] = [];
  let defaultValue: string | null = null;
  for (const th of [...descendants(div)].filter((e) => e.tagName === 'th' && hasClass(e, 'value-name'))) {
    const strong = [...descendants(th)].find((e) => e.tagName === 'strong' && hasClass(e, 'default'));
    const v = squash(text(strong ?? th)).replace(/\s*\(default\)$/, '');
    values.push(v);
    if (strong) defaultValue = v;
  }
  const applicability = squash(text(byClass(div, `${kind}-applicability`) ?? def));
  const description = squash(text(byClass(div, `${kind}-description`) ?? def));
  attributes[name] = {
    kind,
    value,
    values,
    default: defaultValue,
    global: GLOBAL[applicability] ?? 'no',
    deprecated: hasClass(div, 'deprecated'),
    description: description.replace(/^\[Deprecated in ARIA [0-9.]+\]\s*/, '').split(/(?<=\.)\s/)[0],
  };
}

writeFileSync(out, stableJson({
  source: {
    repo: 'https://github.com/w3c/aria',
    commit: git('rev-parse', 'HEAD'),
    date: git('log', '-1', '--format=%cs'),
    file: 'index.html',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  },
  roles,
  attributes,
}));
console.log(`${out}: ${Object.keys(roles).length} roles, ${Object.keys(attributes).length} states and properties`);
