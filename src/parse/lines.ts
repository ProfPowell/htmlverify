export interface Position {
  line: number;
  column: number;
}

/**
 * Maps string offsets to 1-based line and column, counted in UTF-16 code units
 * (the LSP default). CRLF, lone CR, and LF each end a line, as in the HTML
 * input stream preprocessor.
 */
export class LineIndex {
  readonly #starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x0a) this.#starts.push(i + 1);
      else if (c === 0x0d) {
        if (text.charCodeAt(i + 1) === 0x0a) i++;
        this.#starts.push(i + 1);
      }
    }
  }

  position(offset: number): Position {
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.#starts[lo]! + 1 };
  }
}
