export { applyEdits } from '../src/fix/apply.ts';
import { treeSignature as signature } from '../src/fix/equivalence.ts';
import { parseHtml } from '../src/parse/parse.ts';
import { vocabularyBooleans } from '../src/vocab/booleans.ts';
import { DEFAULT_VOCABULARIES, Vocabulary } from '../src/vocab/vocabulary.ts';

const booleans = vocabularyBooleans(new Vocabulary(DEFAULT_VOCABULARIES, null, 'x-'));

/** The tree-equivalence contract for fixes (spec §8), from source text, with the default vocabulary. */
export function treeSignature(text: string, context: string | null): string {
  return signature(parseHtml(text, context), booleans);
}
