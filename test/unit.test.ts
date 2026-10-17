import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeUtf8 } from '../src/parse/decode.ts';
import { LineIndex } from '../src/parse/lines.ts';
import { PARSER } from '../src/parse/parse.ts';
import { canonicalJson } from '../src/report/canonical.ts';
import { readAttribute } from '../src/rules/util.ts';
import { VERSION } from '../src/version.ts';

const ROOT = join(import.meta.dirname, '..');

test('LineIndex counts LF, CRLF, and lone CR as line breaks, in UTF-16 columns', () => {
  const lines = new LineIndex('a\nb\r\nc\rd😀e');
  assert.deepEqual(lines.position(0), { line: 1, column: 1 });
  assert.deepEqual(lines.position(2), { line: 2, column: 1 });
  assert.deepEqual(lines.position(5), { line: 3, column: 1 });
  assert.deepEqual(lines.position(7), { line: 4, column: 1 });
  assert.deepEqual(lines.position(10), { line: 4, column: 4 });
});

test('decodeUtf8 strips a BOM and reports it', () => {
  const result = decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
  assert.deepEqual(result, { ok: true, text: 'a', bom: true });
});

test('decodeUtf8 locates the first invalid byte', () => {
  const cases: [number[], number][] = [
    [[0x61, 0xc3, 0x28], 1], // bad continuation
    [[0xc0, 0x80], 0], // overlong
    [[0x61, 0xed, 0xa0, 0x80], 1], // surrogate
    [[0x61, 0x62, 0xf0, 0x9f, 0x98], 2], // truncated
    [[0xf4, 0x90, 0x80, 0x80], 0], // beyond U+10FFFF
  ];
  for (const [bytes, offset] of cases) {
    const result = decodeUtf8(new Uint8Array(bytes));
    assert.equal(result.ok, false, `bytes ${bytes}`);
    if (!result.ok) assert.equal(result.byteOffset, offset, `bytes ${bytes}`);
  }
});

test('canonicalJson sorts keys, drops undefined, and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: { z: 0, y: -1.5 } }), '{"a":[true,null,"x"],"b":1,"d":{"y":-1.5,"z":0}}');
  assert.throws(() => canonicalJson({ n: Number.NaN }));
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }));
});

test('readAttribute follows the tokenizer, not parse5’s attribute spans', () => {
  const text = '<a href="/x"class="y" hidden title=a/b data-x=\'1\'>';
  assert.deepEqual(readAttribute(text, 3), { name: 'href', quote: '"', valueOffset: 9, valueEndOffset: 11, nameEndOffset: 7, endOffset: 12 });
  assert.equal(readAttribute(text, 12).endOffset, 21);
  assert.equal(readAttribute(text, 22).quote, 'bare');
  assert.equal(text.slice(readAttribute(text, 29).valueOffset, readAttribute(text, 29).valueEndOffset), 'a/b');
  assert.equal(readAttribute(text, 39).quote, "'");
});

test('VERSION matches package.json', () => {
  assert.equal(VERSION, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
});

test('PARSER matches the installed parse5', () => {
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/parse5/package.json'), 'utf8')).version;
  assert.equal(PARSER, `parse5@${installed}`);
});
