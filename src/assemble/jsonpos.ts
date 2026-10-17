import { at } from './params.ts';

/**
 * The offset of every value in a JSON text, by JSON Pointer, so problems
 * found in parsed data can be located in the file. Returns null when the
 * text isn't valid JSON.
 */
export function jsonPointers(text: string): Map<string, number> | null {
  const out = new Map<string, number>();
  let i = 0;
  const space = () => {
    while (i < text.length && /[\t\n\r ]/.test(text[i]!)) i++;
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (pointer: string): void => {
    space();
    out.set(pointer, i);
    const c = text[i];
    if (c === '{') {
      i++;
      space();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        space();
        if (text[i] !== '"') throw new SyntaxError('expected a member name');
        const key = string();
        space();
        if (text[i++] !== ':') throw new SyntaxError('expected ":"');
        value(at(pointer, key));
        space();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return;
        } else throw new SyntaxError('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      space();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        value(at(pointer, n));
        space();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return;
        } else throw new SyntaxError('expected "," or "]"');
      }
    }
    if (c === '"') {
      string();
      return;
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new SyntaxError('expected a value');
    i += m[0].length;
  };
  try {
    value('');
    space();
    return i === text.length ? out : null;
  } catch {
    return null;
  }
}

/** The offset for a pointer: the value itself, or the nearest ancestor that exists. */
export function offsetOf(pointers: ReadonlyMap<string, number>, pointer: string): number {
  for (let p = pointer; ; p = p.slice(0, p.lastIndexOf('/'))) {
    const offset = pointers.get(p);
    if (offset !== undefined) return offset;
    if (p === '') return 0;
  }
}
