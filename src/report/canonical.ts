/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, undefined members omitted, non-finite numbers rejected. Equal
 * values always encode to identical bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: can’t encode ${typeof value}`);
  }
}
