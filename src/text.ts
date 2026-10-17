// Wording helpers for messages and suggestions.

/** "a, b, or c". */
export function words(items: readonly string[], conjunction = 'or'): string {
  if (items.length <= 2) return items.join(` ${conjunction} `);
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items.at(-1)}`;
}

/** "<a>, <b>, or <c>". */
export function tags(names: readonly string[], conjunction = 'or'): string {
  return words(names.map((n) => `<${n}>`), conjunction);
}

/** Edit distance with adjacent transpositions (optimal string alignment). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The candidate nearest to `word`: within one edit for words of up to three
 * characters, two otherwise. Ties go to the first in sorted order.
 */
export function closest(word: string, candidates: Iterable<string>): string | null {
  const max = word.length <= 3 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = max + 1;
  for (const candidate of [...candidates].sort()) {
    if (candidate === word) continue;
    const dist = distance(word, candidate);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }
  return best;
}
