/**
 * The generated half of the feed-go site-search profanity parity fixture
 * (apps/feed-go/testdata/profanity/parity.json). Both runtimes build the same inputs from the shipped
 * lists (this file, and `corpus` in apps/feed-go/internal/profanity/parity_test.go: keep them in step),
 * prove they built the same ones (the fixture's sha256), and the fixture records Node's verdict for
 * each, so the list text itself never has to be written into the fixture.
 */
import { createHash } from 'node:crypto';

export type CorpusSources = {
  blockedWords: readonly string[];
  whitelistWords: readonly string[];
  english: readonly { word: string; whitelistedTerms: readonly string[] }[];
  cleanWord: (word: string) => string;
  isValidWord: (word: string) => boolean;
};

const LEET: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5' };
const upper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/** Each base text in ten spellings: plain, upper-cased, inside and around other words, leetspeak, doubled, dotted, `l` as `|`, a tag list. */
export function corpusInputs(src: CorpusSources): string[] {
  const bases: string[] = [];
  for (const w of src.blockedWords)
    if (src.isValidWord(w)) bases.push(src.cleanWord(w).replace(/\|/g, ''));
  for (const p of src.english) bases.push(p.word, ...p.whitelistedTerms);
  bases.push(...src.whitelistWords);
  const out: string[] = [];
  for (const b of bases) {
    out.push(
      b,
      upper(b),
      'x' + b,
      b + 's',
      'a ' + b + ' b',
      b.replace(/[aeios]/g, (c) => LEET[c]),
      b.replace(/[\s\S]/g, (c) => c + c),
      b.split('').join('.'),
      b.replace(/l/g, '|'),
      '1girl, ' + b + ', solo'
    );
  }
  return out;
}

export function corpusDigest(inputs: readonly string[]): string {
  return createHash('sha256').update(inputs.join('\n')).digest('hex');
}

/** `synthetic(n)`: n managed-list entries on no real list (`zqvox` and the index in letters). */
export function synthetic(n: number): string[] {
  const letters = (i: number) =>
    i.toString(26).replace(/./g, (d) => String.fromCharCode(97 + parseInt(d, 26)));
  return Array.from({ length: n }, (_, i) => `zqvox${letters(i)}`);
}
