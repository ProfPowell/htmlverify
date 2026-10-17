export type Decoded =
  | { ok: true; text: string; bom: boolean }
  /** `prefix` is the valid text before the first invalid byte, for locating it. */
  | { ok: false; byteOffset: number; prefix: string };

/** Decodes UTF-8 strictly. A leading BOM is removed from the text and reported. */
export function decodeUtf8(bytes: Uint8Array): Decoded {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bom };
  } catch {
    const byteOffset = firstInvalidByte(bytes);
    const prefix = new TextDecoder('utf-8').decode(bytes.subarray(bom ? 3 : 0, byteOffset));
    return { ok: false, byteOffset, prefix };
  }
}

/** Index of the first byte that starts an invalid sequence, per the WHATWG UTF-8 decoder. */
function firstInvalidByte(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else return i;
    for (let k = 1; k <= need; k++) {
      const next = bytes[i + k];
      if (next === undefined || next < (k === 1 ? lower : 0x80) || next > (k === 1 ? upper : 0xbf)) return i;
    }
    i += need + 1;
  }
  return bytes.length;
}
