// A unified diff of two texts by line (Myers' O(ND) algorithm), as `diff -u`
// and `git apply` read it.

type Op = { kind: ' ' | '-' | '+'; line: string };

function lines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  // A final newline ends the last line rather than starting an empty one.
  if (parts.at(-1) === '') parts.pop();
  else parts[parts.length - 1] += '\0';
  return parts;
}

/** The shortest edit script from a to b. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk back from (n, m): each round's state says which move led there.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[max + k - 1]! < vd[max + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[max + prevK]!;
    const prevY = prevX - prevK;
    for (; x > prevX && y > prevY; y--) ops.push({ kind: ' ', line: a[--x]! });
    if (x === prevX) ops.push({ kind: '+', line: b[--y]! });
    else ops.push({ kind: '-', line: a[--x]! });
  }
  for (; x > 0 && y > 0; y--) ops.push({ kind: ' ', line: a[--x]! });
  return ops.reverse();
}

export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const ops = myers(lines(before), lines(after));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  const show = (op: Op) => {
    const missingNewline = op.line.endsWith('\0');
    out.push(`${op.kind}${missingNewline ? op.line.slice(0, -1) : op.line}`);
    if (missingNewline) out.push('\\ No newline at end of file');
  };
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === ' ') i++;
    if (i >= ops.length) break;
    // A hunk runs from `context` lines before the first change to `context` after the last one near it.
    const start = Math.max(0, i - context);
    let end = i;
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.kind !== ' ') end = j;
      else if (j - end > 2 * context) break;
    }
    const stop = Math.min(ops.length, end + context + 1);
    let aStart = 0;
    let bStart = 0;
    for (let j = 0; j < start; j++) {
      if (ops[j]!.kind !== '+') aStart++;
      if (ops[j]!.kind !== '-') bStart++;
    }
    const hunk = ops.slice(start, stop);
    const aCount = hunk.filter((o) => o.kind !== '+').length;
    const bCount = hunk.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${aCount === 0 ? aStart : aStart + 1},${aCount} +${bCount === 0 ? bStart : bStart + 1},${bCount} @@`);
    hunk.forEach(show);
    i = stop;
  }
  return `${out.join('\n')}\n`;
}
