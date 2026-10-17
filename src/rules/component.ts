import { childrenOf, isElement, isHtml, isText, isWhitespaceText, walk, type Element } from '../parse/tree.ts';
import { HTML, isEventHandler } from '../spec/data.ts';
import { attr, has, kindOf, mayBeInCategory } from '../spec/model.ts';
import { closest, tags, words } from '../text.ts';
import { REQUIRED } from '../vocab/overlay.ts';
import { matches, parseSelector, type Selector } from '../vocab/select.ts';
import type { VocabAttribute, VocabElement } from '../vocab/types.ts';
import { Vocabulary, type VocabEntry } from '../vocab/vocabulary.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { readAttribute, spanOf } from './util.ts';

const GLOBAL = new Set(HTML.attributes.filter((r) => r.elements.includes('*')).map((r) => r.name));
const RDFA_LITE = new Set(['vocab', 'typeof', 'property', 'resource', 'prefix']);
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/** The component rules (spec §6.4): custom elements against the vocabulary. */
export function checkComponents(ctx: RuleContext): RawFinding[] {
  const vocabulary = ctx.vocabulary;
  if (!vocabulary.configured) return [];
  const out: RawFinding[] = [];
  const span = (e: Element) => spanOf(e, ctx.text);
  const attrSpan = (e: Element, name: string) => {
    const loc = e.sourceCodeLocation?.attrs?.[name];
    return loc ? { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset } : span(e);
  };
  const report = (rule: string, where: { offset: number; endOffset: number }, message: string, extra: Partial<RawFinding> = {}) =>
    out.push({ rule, ...where, message, ...extra });
  const sources = vocabulary.sources.map(Vocabulary.label);
  const declaredIn = words(sources);
  const nobody = sources.length === 1 ? `${sources[0]} doesn’t declare it` : `neither ${sources.slice(0, -1).join(', ')} nor ${sources.at(-1)} declares it`;
  const selectors = new Map<string, Selector | null>();
  const selector = (source: string) => {
    if (!selectors.has(source)) selectors.set(source, parseSelector(source));
    return selectors.get(source)!;
  };
  const checkedChildAttributes = new Set<string>();

  for (const { node } of walk(ctx.parsed.root)) {
    if (!isElement(node) || !node.sourceCodeLocation?.startTag) continue;
    const e = node;
    const custom = kindOf(e) === 'custom';
    const entry = custom || isHtml(e) ? vocabulary.get(e.tagName) : null;
    if (custom && !entry) {
      // A component's manifest can name its own child elements (page-tour's tour-step).
      if (namedByComponent(e, vocabulary, selector)) continue;
      if (vocabulary.isAdHoc(e.tagName)) {
        report('component/unknown-element', span(e), `<${e.tagName}> is ad hoc: ${nobody}. Declare it in the registry’s elements.json, or use a Vanilla Breeze element.`, { severity: 'warning' });
      } else {
        const owners = vocabulary.ownersOf(e.tagName);
        const near = closest(e.tagName, vocabulary.customNames());
        const instead = owners.length > 0 ? ` It’s part of ${tags(owners)}; use it inside one.`
          : near ? ` Did you mean <${near}>?`
          : ` Declare project elements in the registry’s elements.json${vocabulary.adHocPrefix ? `, or prefix a throwaway one with ${vocabulary.adHocPrefix}` : ''}.`;
        report('component/unknown-element', span(e), `<${e.tagName}> isn’t declared in ${declaredIn}.${instead}`, { evidence: { element: e.tagName } });
      }
      continue;
    }
    if (!entry || (!custom && entry.element.type !== 'native')) continue;
    const owner = `<${e.tagName}>`;
    const { element: def } = entry;

    // component/attribute and component/output-attribute
    for (const a of e.attrs) {
      if (a.namespace) continue;
      const spec = def.attributes[a.name];
      if (!spec) {
        if (!custom) continue; // A native element's other attributes are HTML's to judge.
        const declared = Object.keys(def.attributes);
        const near = closest(a.name, declared);
        if (allowedWithoutDeclaration(e, a.name) && !(a.name.startsWith('data-') && near && !givenByAncestor(e, a.name, vocabulary))) continue;
        const list = declared.length === 0 ? ' It has no attributes of its own.' : declared.length <= 8 ? ` Its attributes are ${words(declared, 'and')}.` : '';
        report('component/attribute', attrSpan(e, a.name), `${a.name} isn’t an attribute of ${owner} in ${Vocabulary.label(entry.source)}.${near ? ` Did you mean ${near}?` : list}`, { evidence: { element: e.tagName, attribute: a.name } });
        continue;
      }
      const output = outputReason(spec);
      if (output) report('component/output-attribute', attrSpan(e, a.name), `${owner} sets ${a.name} itself (${output}); remove it from the markup.`);
      else {
        const problem = valueProblem(a.name, a.value, spec, owner);
        if (problem) report('component/attribute', attrSpan(e, a.name), problem);
      }
    }
    for (const [name, spec] of Object.entries(def.attributes)) {
      if (spec.required && !has(e, name)) report('component/attribute', span(e), `${owner} needs a ${name} attribute${spec.description ? ` (${spec.description.replace(/\.$/, '')})` : ''}.`);
    }

    // childAttributes on the children they name
    if (def.childAttributes.length > 0) {
      for (const { node: d } of walk(e)) {
        if (d === e || !isElement(d) || !d.sourceCodeLocation?.startTag) continue;
        for (const c of def.childAttributes) {
          const s = selector(c.on);
          const value = attr(d, c.name);
          if (value === null || !s || !matches(d, s)) continue;
          const key = `${d.sourceCodeLocation.startTag.startOffset}\0${c.name}`;
          if (checkedChildAttributes.has(key)) continue;
          checkedChildAttributes.add(key);
          const problem = valueProblem(c.name, value, c, `<${d.tagName}> in ${owner}`);
          if (problem) report('component/attribute', attrSpan(d, c.name), problem);
        }
      }
    }

    // component/content: children, then the structure the component needs
    if (!custom) continue;
    const kids = childrenOf(e);
    if (def.permittedContent !== null) {
      const allowed = def.permittedContent;
      for (const child of kids) {
        if (isElement(child) && !allowed.some((p) => permits(p, child, vocabulary))) {
          report('component/content', spanOf(child, ctx.text), `${owner} accepts ${describePermitted(allowed)}, not <${child.tagName}>.`);
        }
        if (allowed.length === 0 && isText(child) && !isWhitespaceText(child)) {
          report('component/content', spanOf(child, ctx.text), `${owner} must be empty: it declares no content.`);
        }
      }
    }
    if (entry.source !== 'project') {
      for (const requirement of REQUIRED[e.tagName] ?? []) {
        const s = selector(requirement.selector)!;
        const pool = requirement.child ? kids.filter(isElement) : [...walk(e)].map((w) => w.node).filter((n): n is Element => isElement(n) && n !== e);
        if (!pool.some((n) => matches(n, s))) report('component/content', span(e), `${owner} needs ${requirement.what}.`);
      }
    }
  }
  return out;
}

/** Whether the nearest declared ancestor names this element in its permittedContent or childAttributes. */
function namedByComponent(e: Element, vocabulary: Vocabulary, selector: (source: string) => Selector | null): boolean {
  for (let a = e.parentNode; a && isElement(a); a = a.parentNode) {
    const def = vocabulary.get(a.tagName)?.element;
    if (!def) continue;
    return (def.permittedContent ?? []).includes(e.tagName)
      || def.childAttributes.some((c) => { const s = selector(c.on); return s !== null && matches(e, s) && s.some((part) => part.tag === e.tagName); });
  }
  return false;
}

/** Whether a component ancestor declares the attribute for its children (layout-cover's data-layout-principal). */
function givenByAncestor(e: Element, name: string, vocabulary: Vocabulary): boolean {
  for (let a = e.parentNode; a && isElement(a); a = a.parentNode) {
    if (vocabulary.get(a.tagName)?.element.childAttributes.some((c) => c.name === name)) return true;
  }
  return false;
}

/** Attributes every custom element may carry without declaring them. */
function allowedWithoutDeclaration(e: Element, name: string): boolean {
  return GLOBAL.has(name) || name.startsWith('data-') || name.startsWith('aria-') || name === 'role' || RDFA_LITE.has(name)
    || isEventHandler(e.tagName, name) || name === 'xmlns' || name.startsWith('xml:');
}

/** Why an attribute is the component's to set, or null when authors may write it. */
function outputReason(spec: VocabAttribute): string | null {
  if (spec.direction === 'output') return 'it reflects the component’s state';
  if (spec.purpose === 'output-state') return 'it reflects the component’s state';
  if (spec.purpose === 'internal-hook') return 'it’s an internal hook';
  if (!spec.public && spec.direction !== 'both' && spec.direction !== 'input') return 'it isn’t part of the public API';
  return null;
}

function valueProblem(name: string, value: string, spec: VocabAttribute, owner: string): string | null {
  switch (spec.type) {
    case 'boolean':
      if (value === 'false') return `${name}="false" still turns ${name} on: ${owner} reads it by presence. Remove the attribute to turn it off.`;
      if (value !== '' && value !== 'true' && value.toLowerCase() !== name) return `${name} on ${owner} is on whenever it’s present; write ${name}="true", or remove it.`;
      return null;
    case 'enum': {
      const values = spec.values ?? [];
      if (values.includes(value)) return null;
      const shown = values.filter((v) => v !== '').map((v) => `"${v}"`);
      const near = closest(value, values.filter((v) => v !== ''));
      return value === ''
        ? `${name} on ${owner} needs a value: ${words(shown)}.`
        : `${name}="${value}" isn’t a value of ${name} on ${owner}: use ${words(shown)}.${near ? ` Did you mean "${near}"?` : ''}`;
    }
    case 'number':
      return NUMBER.test(value.trim()) ? null : `${name}="${value}" on ${owner} must be a number.`;
    default:
      return null;
  }
}

/** Whether one permittedContent entry admits a child (html-validate's syntax). */
function permits(entry: string, child: Element, vocabulary: Vocabulary): boolean {
  if (!entry.startsWith('@')) return child.tagName === entry;
  const category = entry.slice(1);
  if (category === 'script') return isHtml(child) && (child.tagName === 'script' || child.tagName === 'template');
  if (kindOf(child) === 'custom') {
    const def: VocabElement | undefined = vocabulary.get(child.tagName)?.element;
    if (!def) return category === 'flow' || category === 'phrasing';
    return category === 'flow' ? def.flow : category === 'phrasing' ? def.phrasing : false;
  }
  // Conditions such as "a hierarchically correct main" are the content rules' to judge.
  return mayBeInCategory(child, category);
}

function describePermitted(entries: readonly string[]): string {
  if (entries.length === 0) return 'no children';
  const names = entries.filter((e) => !e.startsWith('@'));
  const categories = entries.filter((e) => e.startsWith('@')).map((c) => (c === '@script' ? 'script-supporting elements' : `${c.slice(1)} content`));
  return words([...(names.length ? [`${tags(names)} children`] : []), ...categories]);
}

/** Placement for the content-model engine: a vocabulary element that isn't phrasing content. */
export function flowOnly(entry: VocabEntry | null): boolean {
  return entry !== null && entry.element.type !== 'native' && !entry.element.phrasing;
}

