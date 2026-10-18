// Branch coverage (spec §9.10): what a component's fixtures must exercise
// before it can be approved. Each vb-if both ways; each vb-each with 0 items
// (where allowed), 1, and 2 or more; each optional parameter present and
// absent; each enum value and both booleans used. Record fields of list items
// count the same way, across all the items.

import type { Contract } from './contract.ts';
import { isObject, type ParamSpec, type Value } from './params.ts';
import type { CompiledTemplate, Loc, Path, TNode } from './template.ts';

export interface CoverageGoal {
  /** What has to happen: "vb-if hint renders (template.html:4:3)", "type is email", "hint is absent". */
  goal: string;
  met: boolean;
}

type Count = '0' | '1' | '2+';

/** Records what the fixtures of one component exercise; the assembler reports branches and loops as it renders. */
export class Coverage {
  readonly component: string;
  readonly #branches = new Map<string, Set<boolean>>();
  readonly #loops = new Map<string, Set<Count>>();
  readonly #present = new Map<string, Set<boolean>>();
  readonly #values = new Map<string, Set<string>>();

  constructor(component: string) {
    this.component = component;
  }

  /** A vb-if evaluated: `rendered` is whether its children rendered. */
  branch(component: string, loc: Loc, rendered: boolean): void {
    if (component === this.component) add(this.#branches, key(loc), rendered);
  }

  /** A vb-each evaluated over `count` items. */
  loop(component: string, loc: Loc, count: number): void {
    if (component === this.component) add(this.#loops, key(loc), count === 0 ? '0' : count === 1 ? '1' : '2+');
  }

  /** One fixture's data: as written, for presence, and with defaults applied, for values. */
  data(params: Record<string, ParamSpec>, raw: unknown, values: Record<string, Value>): void {
    this.#record(params, isObject(raw) ? raw : {}, values, '');
  }

  #record(params: Record<string, ParamSpec>, raw: Record<string, unknown>, values: Record<string, Value>, prefix: string): void {
    for (const [name, spec] of Object.entries(params)) {
      const path = prefix + name;
      if (!spec.required) add(this.#present, path, raw[name] !== undefined);
      const v = values[name];
      if ((spec.type === 'enum' || spec.type === 'boolean') && v !== undefined) add(this.#values, path, String(v));
      if (spec.type === 'list' && typeof spec.items === 'object' && Array.isArray(v)) {
        const rawItems = Array.isArray(raw[name]) ? (raw[name] as unknown[]) : [];
        v.forEach((item, i) => {
          if (isObject(item)) this.#record(spec.items as Record<string, ParamSpec>, isObject(rawItems[i]) ? rawItems[i] : {}, item as Record<string, Value>, `${path}[].`);
        });
      }
    }
  }

  /** Every goal for the component's template and contract, and whether the fixtures met it. */
  goals(template: CompiledTemplate, contract: Contract): CoverageGoal[] {
    const out: CoverageGoal[] = [];
    const where = (loc: Loc) => `template.html:${loc.line}:${loc.column}`;
    const walk = (nodes: readonly TNode[], scope: ReadonlyMap<string, ParamSpec>) => {
      for (const n of nodes) {
        if (n.kind === 'if') {
          const seen = this.#branches.get(key(n.loc));
          const test = `vb-if="${n.negate ? '!' : ''}${name(n.path)}"`;
          out.push({ goal: `${test} renders (${where(n.loc)})`, met: seen?.has(true) ?? false });
          out.push({ goal: `${test} doesn’t render (${where(n.loc)})`, met: seen?.has(false) ?? false });
          walk(n.children, scope);
        } else if (n.kind === 'each') {
          const list = lookup(n.path, contract.params, scope);
          const seen = this.#loops.get(key(n.loc));
          const min = list?.minItems ?? 0;
          const max = list?.maxItems ?? Infinity;
          const counts: [Count, boolean][] = [['0', min === 0 || list?.required === false], ['1', min <= 1 && max >= 1], ['2+', max >= 2]];
          for (const [count, allowed] of counts) {
            if (allowed) out.push({ goal: `vb-each="${name(n.path)}" with ${count === '2+' ? '2 or more items' : count === '1' ? '1 item' : 'no items'} (${where(n.loc)})`, met: seen?.has(count) ?? false });
          }
          const items = list && typeof list.items === 'object' ? list.items : null;
          walk(n.children, items ? new Map(scope).set(n.as, { type: 'list', required: true, items }) : scope);
        } else if (n.kind === 'element') walk(n.children, scope);
      }
    };
    walk(template.nodes, new Map());
    const params = (specs: Record<string, ParamSpec>, prefix: string) => {
      for (const [param, spec] of Object.entries(specs)) {
        const path = prefix + param;
        const present = this.#present.get(path);
        if (!spec.required && spec.type !== 'boolean') {
          out.push({ goal: `${path} is given`, met: present?.has(true) ?? false });
          out.push({ goal: `${path} is left out`, met: present?.has(false) ?? false });
        }
        const values = spec.type === 'boolean' ? ['true', 'false'] : spec.type === 'enum' ? spec.values ?? [] : [];
        for (const v of values) out.push({ goal: `${path} is ${v}`, met: this.#values.get(path)?.has(v) ?? false });
        if (spec.type === 'list' && typeof spec.items === 'object') params(spec.items, `${path}[].`);
      }
    };
    params(contract.params, '');
    return out;
  }
}

function key(loc: Loc): string {
  return `${loc.line}:${loc.column}`;
}

function add<T>(map: Map<string, Set<T>>, k: string, v: T): void {
  const set = map.get(k) ?? new Set<T>();
  set.add(v);
  map.set(k, set);
}

function name(path: Path): string {
  return path.field === null ? path.root : `${path.root}.${path.field}`;
}

/** The list a vb-each walks: a parameter, or a field of the item an outer vb-each is on. */
function lookup(path: Path, params: Record<string, ParamSpec>, scope: ReadonlyMap<string, ParamSpec>): ParamSpec | null {
  const item = scope.get(path.root);
  if (item) return path.field !== null && typeof item.items === 'object' ? item.items[path.field] ?? null : null;
  const spec = params[path.root];
  if (!spec) return null;
  return path.field === null ? spec : null;
}
