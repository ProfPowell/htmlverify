// Extracts the index tables and obsolete-feature lists from a whatwg/html
// checkout into data/html.json, pinned to the checkout's commit.
//
//   node tools/extract/html.ts <whatwg-html-checkout> [out.json]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type DefaultTreeAdapterTypes as T } from 'parse5';
import { stableJson } from './json.ts';

type Node = T.Node;
type Element = T.Element;

const [checkout, out = 'data/html.json'] = process.argv.slice(2);
if (!checkout) {
  console.error('usage: node tools/extract/html.ts <whatwg-html-checkout> [out.json]');
  process.exit(2);
}

const sourcePath = join(checkout, 'source');
const bytes = readFileSync(sourcePath);
const doc = parse(bytes.toString('utf8'));
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function* descendants(node: Node): Generator<Element> {
  const kids = 'content' in node && node.tagName === 'template' ? (node as T.Template).content.childNodes : 'childNodes' in node ? node.childNodes : [];
  for (const kid of kids) {
    if (!isElement(kid)) continue;
    yield kid;
    yield* descendants(kid);
  }
}

// Bibliography references (<ref>) are dropped from extracted text.
function text(node: Node): string {
  if (node.nodeName === '#text') return (node as T.TextNode).value;
  if (!('childNodes' in node) || node.nodeName === 'ref') return '';
  return node.childNodes.map(text).join('');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const cellsOf = (row: Element) => row.childNodes.filter((n): n is Element => isElement(n) && (n.tagName === 'td' || n.tagName === 'th'));
const codes = (node: Element) => [...descendants(node)].filter((e) => e.tagName === 'code').map((e) => squash(text(e)));
const list = (cell: Element) => squash(text(cell)).split(';').map((s) => s.trim()).filter((s) => s && s !== '—');

function table(predicate: (table: Element) => boolean): Element[] {
  const found = [...descendants(doc)].find((e) => e.tagName === 'table' && predicate(e));
  if (!found) throw new Error('table not found');
  return [...descendants(found)].filter((e) => e.tagName === 'tr' && cellsOf(e).some((c) => c.tagName === 'td'));
}

const byCaption = (caption: string) => (t: Element) =>
  t.childNodes.some((n) => isElement(n) && n.tagName === 'caption' && squash(text(n)) === caption);
const byId = (id: string) => (t: Element) => t.attrs.some((a) => a.name === 'id' && a.value === id);
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
// Cells with colspan repeated, so each lands in its column.
const columns = (row: Element) => cellsOf(row).flatMap((c) => Array<Element>(Number(attr(c, 'colspan') ?? 1)).fill(c));

// List of elements.
const elements: Record<string, unknown> = {};
for (const row of table(byCaption('List of elements'))) {
  const [names, description, categories, parents, children, attributes, iface] = cellsOf(row);
  if (!names || !description || !categories || !parents || !children || !attributes || !iface) continue;
  for (const name of codes(names)) {
    elements[name] = {
      description: squash(text(description)),
      categories: list(categories).filter((c) => c !== 'none'),
      parents: list(parents),
      children: list(children),
      attributes: codes(attributes),
      interface: squash(text(iface)),
    };
  }
}

// List of element content categories, with the conditional members.
const categories: Record<string, unknown> = {};
for (const row of table(byCaption('List of element content categories'))) {
  const [name, members, exceptions] = cellsOf(row);
  if (!name || !members || !exceptions) continue;
  categories[squash(text(name))] = {
    elements: codes(members),
    conditional: list(exceptions).map((item) => {
      const match = /^(\S+)\s*(?:\((.*)\))?$/.exec(item);
      return { element: match?.[1] ?? item, condition: match?.[2] ?? '' };
    }),
  };
}

// Attributes, one entry per row: an attribute can mean different things on different elements.
const attributes: unknown[] = [];
for (const row of table(byId('attributes-1'))) {
  const [name, on, description, value] = cellsOf(row);
  if (!name || !on || !description || !value) continue;
  const valueText = squash(text(value));
  const onText = squash(text(on));
  // Quoted keywords; `closed` when the value is nothing but keywords (and the empty string).
  const keywords = [...valueText.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const rest = valueText.replace(/"[^"]*"/g, '').replace(/the empty string/, '').replace(/[;\s]/g, '');
  attributes.push({
    name: squash(text(name)),
    elements: /HTML elements/.test(onText) ? ['*'] : codes(on),
    on: onText,
    description: squash(text(description)),
    value: valueText,
    keywords,
    closed: keywords.length > 0 && rest === '',
    emptyAllowed: /the empty string/.test(valueText),
  });
}

// Element definitions: the normative Categories, Contexts, and Content model
// text from each <dl class="element">, with the section URL.
const definitions: Record<string, unknown> = {};
{
  let file = '';
  let heading: Element | null = null;
  for (const element of descendants(doc)) {
    const split = element.attrs.find((a) => a.name === 'split-filename');
    if (split) file = split.value;
    if (/^h[2-6]$/.test(element.tagName)) heading = element;
    if (element.tagName !== 'dl' || !element.attrs.some((a) => a.name === 'class' && a.value === 'element') || !heading) continue;
    const dfns = [...descendants(heading)].filter((e) => e.tagName === 'dfn' && e.attrs.some((a) => a.name === 'element'));
    const names = (dfns.length ? dfns.flatMap(codes) : codes(heading)).filter((n) => n in elements);
    const anchor = heading.attrs.find((a) => a.name === 'id')?.value ?? squash(text(heading)).toLowerCase().replace(/\s+/g, '-');
    const sections: Record<string, string[]> = {};
    let current = '';
    for (const node of element.childNodes) {
      if (!isElement(node)) continue;
      if (node.tagName === 'dt') current = squash(text(node)).replace(/:$/, '');
      else if (node.tagName === 'dd' && current) (sections[current] ??= []).push(squash(text(node)));
    }
    for (const name of names) {
      definitions[name] = {
        url: `https://html.spec.whatwg.org/multipage/${file}.html#${anchor}`,
        categories: sections['Categories'] ?? [],
        contexts: sections['Contexts in which this element can be used'] ?? [],
        contentModel: sections['Content model'] ?? [],
        attributes: sections['Content attributes'] ?? [],
        tagOmission: sections['Tag omission in text/html'] ?? [],
      };
    }
  }
}

// Event handler content attributes.
const eventHandlers: unknown[] = [];
for (const row of table(byId('ix-event-handlers'))) {
  const [name, on] = cellsOf(row);
  if (!name || !on) continue;
  eventHandlers.push({ name: squash(text(name)), on: squash(text(on)) });
}

// Link types: what each rel keyword means on link, on a and area, and on form.
const linkTypes: unknown[] = [];
for (const row of table(byId('table-link-relations'))) {
  const [keyword, link, aArea, form, bodyOk] = columns(row);
  if (!keyword || !link || !aArea || !form || !bodyOk) continue;
  const effect = (cell: Element) => (/not allowed/.test(text(cell)) ? null : squash(text(cell)));
  for (const name of codes(keyword)) {
    linkTypes.push({ keyword: name, link: effect(link), aArea: effect(aArea), form: effect(form), bodyOk: attr(bodyOk, 'class') === 'yes' });
  }
}

// Input types, and which content attributes apply to each.
const inputTypes: unknown[] = [];
for (const row of table(byId('attr-input-type-keywords'))) {
  const [keyword, state] = cellsOf(row);
  if (!keyword || !state) continue;
  inputTypes.push({ keyword: codes(keyword)[0], state: squash(text(state)) });
}
const inputAttributes: Record<string, string[]> = {};
{
  const summary = [...descendants(doc)].find((e) => e.tagName === 'table' && byId('input-type-attr-summary')(e));
  if (!summary) throw new Error('input summary table not found');
  const rows = [...descendants(summary)].filter((e) => e.tagName === 'tr');
  const header = rows.find((r) => r.parentNode && isElement(r.parentNode) && r.parentNode.tagName === 'thead');
  if (!header) throw new Error('input summary header not found');
  const groups = cellsOf(header).slice(1).map((th) =>
    [...descendants(th)].flatMap((e) => /^attr-input-type-(.+)$/.exec(attr(e, 'data-x') ?? '')?.[1] ?? []));
  let section = 0;
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length === 1 && attr(cells[0]!, 'scope') === 'rowgroup') section++;
    if (section !== 1 || cells.length !== groups.length + 1) continue;
    const name = codes(cells[0]!)[0];
    if (!name) continue;
    inputAttributes[name] = cells.slice(1).flatMap((c, i) => (attr(c, 'class') === 'yes' ? groups[i]! : []));
  }
}

// Autofill detail tokens: the lists in the order the grammar gives them.
const autofill = (() => {
  const p = [...descendants(doc)].find((e) => e.tagName === 'p' && squash(text(e)).startsWith('Autofill detail tokens are the following'));
  const siblings = p?.parentNode?.childNodes ?? [];
  const ol = siblings.slice(siblings.indexOf(p as Element) + 1).find((n): n is Element => isElement(n) && n.tagName === 'ol');
  if (!ol) throw new Error('autofill grammar not found');
  const lists = [...descendants(ol)].filter((e) => e.tagName === 'ul' && attr(e, 'class') === 'brief').map(codes);
  const [modes, fields, contactTypes, contactFields] = lists;
  if (lists.length !== 4 || !modes || !fields || !contactTypes || !contactFields) throw new Error(`expected 4 autofill lists, found ${lists.length}`);
  return { modes, fields, contactTypes, contactFields };
})();

// Obsolete features: a <dl> after a lead-in paragraph; consecutive <dt>s share the next <dd>.
function obsoleteList(leadIn: string): { terms: string[][]; advice: string }[] {
  const p = [...descendants(doc)].find((e) => e.tagName === 'p' && squash(text(e)).startsWith(leadIn));
  if (!p?.parentNode) throw new Error(`lead-in not found: ${leadIn}`);
  const siblings = p.parentNode.childNodes;
  const dl = siblings.slice(siblings.indexOf(p) + 1).find((n): n is Element => isElement(n) && n.tagName === 'dl');
  if (!dl) throw new Error(`list not found after: ${leadIn}`);
  const groups: { terms: string[][]; advice: string }[] = [];
  let pending: string[][] = [];
  for (const node of dl.childNodes) {
    if (!isElement(node)) continue;
    if (node.tagName === 'dt') pending.push(codes(node));
    else if (node.tagName === 'dd') {
      groups.push({ terms: pending, advice: squash(text(node)) });
      pending = [];
    }
  }
  return groups;
}

const obsoleteElements = obsoleteList('Elements in the following list are entirely obsolete').flatMap((g) =>
  g.terms.map(([name]) => ({ element: name, advice: g.advice })));
const obsoleteAttributes = obsoleteList('The following attributes are obsolete').flatMap((g) =>
  g.terms.map(([name, ...on]) => ({ attribute: name, elements: on, advice: g.advice })));

writeFileSync(out, stableJson({
  source: {
    repo: 'https://github.com/whatwg/html',
    commit: git('rev-parse', 'HEAD'),
    date: git('log', '-1', '--format=%cs'),
    file: 'source',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  },
  elements,
  definitions,
  categories,
  attributes,
  autofill,
  eventHandlers,
  inputAttributes,
  inputTypes,
  linkTypes,
  obsoleteElements,
  obsoleteAttributes,
}));
console.log(`${out}: ${Object.keys(elements).length} elements, ${Object.keys(definitions).length} definitions, ${attributes.length} attribute rows, ${eventHandlers.length} event handlers, ${linkTypes.length} link types, ${inputTypes.length} input types, ${Object.keys(inputAttributes).length} input attributes, ${autofill.fields.length + autofill.contactFields.length} autofill fields, ${obsoleteElements.length} obsolete elements, ${obsoleteAttributes.length} obsolete attributes`);
