// Child grammars (spec §7.2): regular expressions over an element's children,
// compiled to Thompson NFAs and simulated one child at a time.
//
//   grammar  := alt
//   alt      := seq ('|' seq)*
//   seq      := item*
//   item     := atom ('?' | '*' | '+')?
//   atom     := name | '@'category | '#text' | '%transparent' | '(' alt ')'
//
// `empty` is the empty sequence and `text` is `#text*`.

export type Token =
  | { kind: 'element'; name: string }
  | { kind: 'category'; name: string }
  | { kind: 'text' };

type Ast =
  | { type: 'token'; token: Token }
  | { type: 'transparent' }
  | { type: 'seq'; items: Ast[] }
  | { type: 'alt'; options: Ast[] }
  | { type: 'repeat'; node: Ast; min: 0 | 1; many: boolean };

export function parseGrammar(source: string): Ast {
  const words = source.match(/[()|?*+]|[@#%]?[a-z][a-z0-9-]*/g) ?? [];
  if (words.join('') !== source.replace(/\s+/g, '')) throw new Error(`bad grammar: ${source}`);
  let i = 0;
  const alt = (): Ast => {
    const options = [seq()];
    while (words[i] === '|') {
      i++;
      options.push(seq());
    }
    return options.length === 1 ? options[0]! : { type: 'alt', options };
  };
  const seq = (): Ast => {
    const items: Ast[] = [];
    while (i < words.length && words[i] !== '|' && words[i] !== ')') items.push(item());
    return items.length === 1 ? items[0]! : { type: 'seq', items };
  };
  const item = (): Ast => {
    let node = atom();
    const op = words[i];
    if (op === '?' || op === '*' || op === '+') {
      i++;
      node = { type: 'repeat', node, min: op === '+' ? 1 : 0, many: op !== '?' };
    }
    return node;
  };
  const atom = (): Ast => {
    const word = words[i++];
    if (word === '(') {
      const inner = alt();
      if (words[i++] !== ')') throw new Error(`bad grammar: ${source}`);
      return inner;
    }
    if (word === undefined || /^[)|?*+]$/.test(word)) throw new Error(`bad grammar: ${source}`);
    if (word === 'empty') return { type: 'seq', items: [] };
    if (word === 'text') return { type: 'repeat', node: { type: 'token', token: { kind: 'text' } }, min: 0, many: true };
    if (word === '#text') return { type: 'token', token: { kind: 'text' } };
    if (word === '%transparent') return { type: 'transparent' };
    if (word.startsWith('@')) return { type: 'token', token: { kind: 'category', name: word.slice(1) } };
    if (word.startsWith('#') || word.startsWith('%')) throw new Error(`bad grammar: ${source}`);
    return { type: 'token', token: { kind: 'element', name: word } };
  };
  const ast = alt();
  if (i !== words.length) throw new Error(`bad grammar: ${source}`);
  return ast;
}

interface State {
  eps: number[];
  edges: { token: Token; to: number }[];
}

export interface Nfa {
  states: State[];
  start: number;
  accept: number;
  /** Every token the grammar mentions. */
  tokens: Token[];
}

/**
 * Compiles a grammar. `%transparent` becomes `(t₁ | t₂ | …)*` over the tokens
 * the parent allows where the transparent element sits.
 */
export function compile(ast: Ast, transparent: readonly Token[]): Nfa {
  const states: State[] = [];
  const add = () => states.push({ eps: [], edges: [] }) - 1;
  const build = (node: Ast): [number, number] => {
    switch (node.type) {
      case 'token': {
        const s = add();
        const e = add();
        states[s]!.edges.push({ token: node.token, to: e });
        return [s, e];
      }
      case 'transparent':
        return build({ type: 'repeat', node: { type: 'alt', options: transparent.map((token) => ({ type: 'token', token })) }, min: 0, many: true });
      case 'seq': {
        const s = add();
        let end = s;
        for (const item of node.items) {
          const [is, ie] = build(item);
          states[end]!.eps.push(is);
          end = ie;
        }
        return [s, end];
      }
      case 'alt': {
        const s = add();
        const e = add();
        for (const option of node.options) {
          const [os, oe] = build(option);
          states[s]!.eps.push(os);
          states[oe]!.eps.push(e);
        }
        return [s, e];
      }
      case 'repeat': {
        const s = add();
        const e = add();
        const [is, ie] = build(node.node);
        states[s]!.eps.push(is);
        if (node.min === 0) states[s]!.eps.push(e);
        states[ie]!.eps.push(e);
        if (node.many) states[ie]!.eps.push(is);
        return [s, e];
      }
    }
  };
  const [start, accept] = build(ast);
  const tokens = uniqueTokens(states.flatMap((s) => s.edges.map((e) => e.token)));
  return { states, start, accept, tokens };
}

export function tokenKey(token: Token): string {
  return token.kind === 'text' ? '#text' : token.kind === 'category' ? `@${token.name}` : token.name;
}

function uniqueTokens(tokens: Token[]): Token[] {
  const seen = new Map<string, Token>();
  for (const token of tokens) if (!seen.has(tokenKey(token))) seen.set(tokenKey(token), token);
  return [...seen.values()];
}

/** Simulates an NFA over a sequence of children. */
export class Matcher {
  private readonly nfa: Nfa;
  private current: Set<number>;

  constructor(nfa: Nfa) {
    this.nfa = nfa;
    this.current = this.closure([nfa.start]);
  }

  /** Consumes one child; returns false, leaving the state unchanged, when nothing accepts it. */
  step(accepts: (token: Token) => boolean): boolean {
    const next: number[] = [];
    for (const s of this.current) {
      for (const edge of this.nfa.states[s]!.edges) if (accepts(edge.token)) next.push(edge.to);
    }
    if (next.length === 0) return false;
    this.current = this.closure(next);
    return true;
  }

  /** Whether the next child could be consumed, without consuming it. */
  canStep(accepts: (token: Token) => boolean): boolean {
    for (const s of this.current) {
      if (this.nfa.states[s]!.edges.some((edge) => accepts(edge.token))) return true;
    }
    return false;
  }

  /** Tokens that could match the next child, in grammar order. */
  expected(): Token[] {
    const keys = new Set([...this.current].flatMap((s) => this.nfa.states[s]!.edges.map((e) => tokenKey(e.token))));
    return this.nfa.tokens.filter((t) => keys.has(tokenKey(t)));
  }

  /** Whether any token anywhere in the grammar accepts the child. */
  anywhere(accepts: (token: Token) => boolean): boolean {
    return this.nfa.tokens.some(accepts);
  }

  accepting(): boolean {
    return this.current.has(this.nfa.accept);
  }

  /** Identifies the current state set, to tell repeated failures apart. */
  key(): string {
    return [...this.current].sort((a, b) => a - b).join(',');
  }

  private closure(from: number[]): Set<number> {
    const seen = new Set<number>(from);
    const stack = [...from];
    while (stack.length > 0) {
      for (const to of this.nfa.states[stack.pop()!]!.eps) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    return seen;
  }
}
