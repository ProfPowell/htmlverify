import { childrenOf, isComment, isElement, isHtml, isText, isWhitespaceText, type ChildNode, type Element } from '../parse/tree.ts';
import { HTML_ELEMENTS, obsoleteElement } from '../spec/data.ts';
import { compile, Matcher, parseGrammar, tokenKey, type Nfa, type Token } from '../spec/grammar.ts';
import { attr, has, inCategory, kindOf, modelOf, nameOf, textInCategory, variantOf, type Env, type Forbid, type Variant } from '../spec/model.ts';
import { isTimeValue } from '../spec/values.ts';
import { closest, words } from '../text.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { at, describe, spanOf } from './util.ts';

export interface ContentResult {
  findings: RawFinding[];
  untested: { check: string; reason: string }[];
}

/** Tokens a transparent element inherits, and the element they come from (null: none, so flow). */
interface Inherited {
  tokens: readonly Token[];
  from: Element | null;
}

interface Prohibition {
  ancestor: Element;
  forbid: readonly Forbid[];
}

const FLOW: Inherited = { tokens: [{ kind: 'category', name: 'flow' }], from: null };

function describeToken(token: Token): string {
  if (token.kind === 'text') return 'text';
  if (token.kind === 'element') return `<${token.name}>`;
  return token.name === 'script-supporting' ? 'script-supporting elements' : `${token.name} content`;
}

const describeTokens = (tokens: readonly Token[]) => words(tokens.map(describeToken));

const nfaCache = new Map<string, Nfa>();

function nfaFor(variant: Variant, inherited: Inherited): Nfa {
  const key = variant.content.includes('%transparent')
    ? `${variant.content}|${inherited.tokens.map(tokenKey).join(' ')}`
    : variant.content;
  let nfa = nfaCache.get(key);
  if (!nfa) {
    nfa = compile(parseGrammar(variant.content), inherited.tokens);
    nfaCache.set(key, nfa);
  }
  return nfa;
}

const acceptsText = (t: Token) => t.kind === 'text' || (t.kind === 'category' && textInCategory(t.name));

function acceptsElement(child: Element, ancestors: readonly Element[]) {
  return (t: Token) => (t.kind === 'element' ? nameOf(child) === t.name : t.kind === 'category' && inCategory(child, t.name, ancestors));
}

/**
 * content/child, content/order, content/context, content/descendant, and the
 * element half of content/unknown-element and content/obsolete. Children are
 * matched against their parent's grammar; a transparent element takes the
 * tokens its parent allows where it sits; descendant prohibitions apply at any
 * depth within a scope; template contents are scopes of their own.
 */
export function checkContentModel(ctx: RuleContext): ContentResult {
  const findings: RawFinding[] = [];
  const notes = new Set<'foreign' | 'noscript'>();
  const document = ctx.parsed.kind === 'document';

  const report = (rule: string, node: ChildNode, message: string, evidence?: RawFinding['evidence']) => {
    findings.push({ rule, ...spanOf(node, ctx.text), message, ...(evidence ? { evidence } : {}) });
  };

  /** Checks an element's children against its model; `env` is null at a scope root. */
  const visit = (
    element: Element,
    env: Env | null,
    inherited: Inherited,
    prohibitions: readonly Prohibition[],
    children: readonly ChildNode[] = element.childNodes,
  ) => {
    const ancestors = [element, ...(env?.ancestors ?? [])];
    const kind = kindOf(element);
    if (kind === 'foreign') {
      notes.add('foreign');
      // HTML inside foreign content (foreignObject, annotation-xml) starts a fresh context.
      const stack = [...children];
      while (stack.length) {
        const node = stack.pop()!;
        if (!isElement(node)) continue;
        if (isHtml(node)) place(node, null, [], [], null, prohibitions);
        else stack.push(...node.childNodes);
      }
      return;
    }
    if (isHtml(element) && element.tagName === 'label') checkLabel(element);
    const model = modelOf(element);
    if (!model) {
      // Unknown and obsolete elements: their children aren't matched, but they're checked themselves.
      for (const child of children) if (isElement(child)) place(child, element, ancestors, children, null, prohibitions);
      return;
    }
    if (model.opaque) {
      if (element.tagName === 'noscript') notes.add('noscript');
      if (element.tagName === 'template') {
        // A fragment parsed in a template context holds the contents itself.
        const content = env === null && element === ctx.parsed.context ? children : childrenOf(element);
        for (const child of content) if (isElement(child)) place(child, null, [], content, null, []);
      }
      return;
    }

    const variant = variantOf(model, env ?? { element, parent: null, ancestors: [], siblings: [] });
    const nfa = nfaFor(variant, inherited);
    const matcher = new Matcher(nfa);
    const own = [...(model.forbid ?? []), ...(variant.forbid ?? [])];
    const active = own.length ? [...prohibitions, { ancestor: element, forbid: own }] : prohibitions;
    const transparent = variant.content.includes('%transparent');
    const purelyTransparent = variant.content === '%transparent';
    const name = variant.as ?? `<${element.tagName}>`;
    const hint = model.hint ? ` ${model.hint}` : '';
    let failed = false;
    let lastOrderFailure = '';

    const fail = (child: ChildNode, accepts: (t: Token) => boolean) => {
      failed = true;
      const what = isElement(child) ? describe(child) : 'Text';
      if (matcher.anywhere(accepts)) {
        // The grammar allows the child, just not here. Once per state, so one misplaced child reports once.
        if (lastOrderFailure === matcher.key()) return;
        lastOrderFailure = matcher.key();
        const expected = matcher.expected();
        const where = expected.length ? `expected ${describeTokens(expected)} here` : `nothing more is allowed after ${previous(child, children)}`;
        report('content/order', child, `${what} is out of order in ${name}: ${where}.${hint}`);
        return;
      }
      const allowed = nfa.tokens.length === 0 ? 'which must be empty' : `which accepts only ${describeTokens(nfa.tokens)}`;
      const through = purelyTransparent && inherited.from ? ` here: it’s transparent, so it takes its content model from <${inherited.from.tagName}>,` : ',';
      report('content/child', child, `${what} isn’t allowed in ${name}${through} ${allowed}.${hint}`);
    };

    const counted = new Map<string, Element[]>();
    for (const child of children) {
      if (isComment(child) || isWhitespaceText(child)) continue;
      if (isText(child)) {
        if (!matcher.step(acceptsText)) fail(child, acceptsText);
        continue;
      }
      if (!isElement(child)) continue;
      const childName = nameOf(child);
      if (childName !== null && model.counts?.[childName]) counted.set(childName, [...(counted.get(childName) ?? []), child]);
      const skip = variant.scriptSupporting && isHtml(child) && (child.tagName === 'script' || child.tagName === 'template');
      place(child, element, ancestors, children, skip ? null : { matcher, fail, from: transparent ? inherited.from : element }, active);
    }

    if (!failed && isHtml(element) && element.tagName === 'time' && !has(element, 'datetime')) {
      const value = children.filter(isText).map((t) => t.value).join('').trim();
      if (!isTimeValue(value)) {
        report('content/child', element, `<time> without datetime must contain a machine-readable date or time, such as 2026-10-17 or 14:30. To show other text, put the value in datetime="…".`);
      }
    }
    if (!failed && !matcher.accepting()) {
      report('content/child', element, model.missing
        ? `<${element.tagName}> ${model.missing}.`
        : `${name} is incomplete: expected ${describeTokens(matcher.expected())} before </${element.tagName}>.${hint}`);
    }
    if (model.counts && document) {
      for (const [child, [min, max]] of Object.entries(model.counts)) {
        const found = counted.get(child) ?? [];
        if (found.length < min) {
          report('content/order', element, `<${element.tagName}> needs ${min === max ? 'exactly' : 'at least'} one <${child}>; it has none.${hint}`);
        }
        for (const extra of found.slice(max)) {
          report('content/order', extra, `<${element.tagName}> can have only one <${child}>; the first is at ${at(ctx, spanOf(found[0]!, ctx.text).offset)}.`);
        }
      }
    }
  };

  /**
   * Places a child: prohibitions from its ancestors, unknown and obsolete
   * elements, its context, then the parent's grammar. Visits it with the tokens
   * it inherits when the grammar accepted it, and as flow content otherwise.
   */
  const place = (
    child: Element,
    parent: Element | null,
    ancestors: readonly Element[],
    siblings: readonly ChildNode[],
    slot: { matcher: Matcher; fail: (child: ChildNode, accepts: (t: Token) => boolean) => void; from: Element | null } | null,
    prohibitions: readonly Prohibition[],
  ) => {
    const env: Env = { element: child, parent, ancestors, siblings };
    for (const p of prohibitions) {
      const hit = p.forbid.find((f) => f.test(child, ancestors));
      if (hit) report('content/descendant', child, `${describe(child)} can’t be inside ${describe(p.ancestor)}, which must not contain ${hit.what}.`);
    }
    const kind = kindOf(child);
    if (kind === 'unknown' || kind === 'obsolete') {
      if (kind === 'unknown') report('content/unknown-element', child, unknownMessage(child.tagName), { element: child.tagName });
      else report('content/obsolete', child, `<${child.tagName}> is obsolete. ${obsoleteElement(child.tagName)}`, { element: child.tagName });
      visit(child, env, FLOW, prohibitions);
      return;
    }
    const problem = parent && kind !== 'foreign' ? modelOf(child)?.context?.(env) : null;
    if (problem) {
      report('content/context', child, `${describe(child)} ${problem}; here its parent is ${describe(parent!)}.`);
      visit(child, env, FLOW, prohibitions);
      return;
    }
    if (!slot || (kind === 'foreign' && nameOf(child) === null)) {
      visit(child, env, FLOW, prohibitions);
      return;
    }
    const accepts = acceptsElement(child, ancestors);
    if (slot.matcher.step(accepts)) {
      visit(child, env, { tokens: slot.matcher.expected(), from: slot.from }, prohibitions);
      return;
    }
    slot.fail(child, accepts);
    visit(child, env, FLOW, prohibitions);
  };

  /** A label labels one control: its for target, or else its first labelable descendant. */
  const checkLabel = (label: Element) => {
    const forId = attr(label, 'for');
    const labelable: Element[] = [];
    const stack = [...label.childNodes].reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (!isElement(node)) continue;
      if (inCategory(node, 'labelable', [])) labelable.push(node);
      stack.push(...[...node.childNodes].reverse());
    }
    const first = labelable[0];
    const extras = forId === null ? labelable.slice(1) : labelable.filter((e) => attr(e, 'id') !== forId);
    for (const extra of extras) {
      report('content/descendant', extra, forId === null || !first
        ? `${describe(extra)} can’t be inside <label>, which already labels ${describe(first!)} at ${at(ctx, spanOf(first!, ctx.text).offset)}; a label contains only the control it labels.`
        : `${describe(extra)} can’t be inside <label for="${forId}">, which labels another control; a label contains only the control it labels.`);
    }
  };

  const root = ctx.parsed.root;
  const context = ctx.parsed.kind === 'fragment' ? ctx.parsed.context : null;
  if (context) visit(context, null, FLOW, [], childrenOf(root));
  else for (const node of childrenOf(root)) if (isElement(node)) visit(node, null, FLOW, []);

  const untested: ContentResult['untested'] = [];
  if (notes.has('foreign')) untested.push({ check: 'content rules inside <svg> and <math>', reason: 'foreign content isn’t modeled' });
  if (notes.has('noscript')) untested.push({ check: 'content rules inside <noscript>', reason: 'parsed as text, as browsers with scripting enabled do' });
  return { findings, untested };
}

function previous(child: ChildNode, siblings: readonly ChildNode[]): string {
  for (let i = siblings.indexOf(child) - 1; i >= 0; i--) {
    const node = siblings[i]!;
    if (isElement(node)) return describe(node);
    if (isText(node) && !isWhitespaceText(node)) return 'text';
  }
  return 'the start';
}

/** Names an HTML element within two edits, or explains custom element names. */
function unknownMessage(name: string): string {
  if (name.includes('-')) return `<${name}> isn’t an HTML element, and its name is reserved for SVG and MathML, so it can’t be a custom element.`;
  const near = closest(name, HTML_ELEMENTS);
  if (near) return `<${name}> isn’t an HTML element. Did you mean <${near}>?`;
  return `<${name}> isn’t an HTML element, and without a hyphen in its name it isn’t a custom element either.`;
}
