import { treeSignature as signature } from '../src/fix/equivalence.ts';
import { parseHtml } from '../src/parse/parse.ts';
import type { Edit } from '../src/rules/types.ts';

/** Applies non-overlapping edits; throws if any two overlap. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.offset - b.offset || a.endOffset - b.endOffset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (next.offset < prev.endOffset || (next.offset === prev.offset && next.offset === next.endOffset && prev.offset === prev.endOffset)) {
      throw new Error(`overlapping edits at ${prev.offset}-${prev.endOffset} and ${next.offset}-${next.endOffset}`);
    }
  }
  let out = text;
  for (const edit of sorted.reverse()) out = out.slice(0, edit.offset) + edit.text + out.slice(edit.endOffset);
  return out;
}

/** The tree-equivalence contract for fixes (spec §8), from source text. */
export function treeSignature(text: string, context: string | null): string {
  return signature(parseHtml(text, context));
}
