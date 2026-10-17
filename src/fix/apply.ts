import type { Edit } from '../rules/types.ts';

const key = (e: Edit) => `${e.offset}\0${e.endOffset}\0${e.text}`;

/** Whether two edits touch the same text: overlapping ranges, or two insertions at one point. */
export function conflicts(a: Edit, b: Edit): boolean {
  if (key(a) === key(b)) return false;
  if (a.offset === a.endOffset && b.offset === b.endOffset) return a.offset === b.offset;
  return a.offset < b.endOffset && b.offset < a.endOffset;
}

/** Applies edits, once each when several findings propose the same one; throws if any two conflict. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const unique = [...new Map(edits.map((e) => [key(e), e])).values()].sort((a, b) => a.offset - b.offset || a.endOffset - b.endOffset);
  for (let i = 1; i < unique.length; i++) {
    if (conflicts(unique[i - 1]!, unique[i]!)) {
      throw new Error(`overlapping edits at ${unique[i - 1]!.offset}-${unique[i - 1]!.endOffset} and ${unique[i]!.offset}-${unique[i]!.endOffset}`);
    }
  }
  let out = text;
  for (const edit of unique.reverse()) out = out.slice(0, edit.offset) + edit.text + out.slice(edit.endOffset);
  return out;
}
