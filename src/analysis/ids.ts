import { childrenOf, isElement, isHtml, type Element, type Node } from '../parse/tree.ts';

/** A tree in which IDs must be unique: the document or fragment, or one template's contents. */
export interface Scope {
  kind: 'document' | 'fragment' | 'template';
  /** The template whose contents form the scope; null for the top level. */
  template: Element | null;
  /** Elements by ID, in tree order. */
  ids: Map<string, Element[]>;
}

export interface IdIndex {
  scopes: Scope[];
  scopeOf: Map<Element, Scope>;
}

/** Indexes IDs per scope. Template contents (declarative shadow roots included) are scopes of their own. */
export function indexIds(root: Node, kind: 'document' | 'fragment'): IdIndex {
  const top: Scope = { kind, template: null, ids: new Map() };
  const scopes = [top];
  const scopeOf = new Map<Element, Scope>();
  const stack: { node: Node; scope: Scope }[] = [{ node: root, scope: top }];
  while (stack.length) {
    const { node, scope } = stack.pop()!;
    if (isElement(node)) {
      scopeOf.set(node, scope);
      const id = node.attrs.find((a) => a.name === 'id' && !a.namespace)?.value;
      if (id !== undefined) {
        const list = scope.ids.get(id);
        if (list) list.push(node);
        else scope.ids.set(id, [node]);
      }
    }
    let inner = scope;
    if (isElement(node) && isHtml(node) && node.tagName === 'template') {
      inner = { kind: 'template', template: node, ids: new Map() };
      scopes.push(inner);
    }
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, scope: inner });
  }
  return { scopes, scopeOf };
}

/** The first element with this ID in the element's scope. */
export function resolveId(index: IdIndex, from: Element, id: string): Element | null {
  return index.scopeOf.get(from)?.ids.get(id)?.[0] ?? null;
}
