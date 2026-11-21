import {
  englishDataset,
  parseRawPattern,
  SyntaxKind,
  type ParsedPattern,
  type RegExpMatcher,
} from 'obscenity';
import { createAnyTermPrefilter } from '~/libs/profanity-simple/any-term-prefilter';
import { describe, expect, it } from 'vitest';
import { blockedWords, whitelistWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord } from '@civitai/mod-utils/profanity/word-rules';
import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import { formatStickerToken } from '~/shared/utils/sticker-token';

// Inputs are built from the lists at runtime and failures name an input's position, never the
// input: this file and its CI logs are public.

/** One string per way through a pattern: each optional both ways, a wildcard as a letter. */
function samplesOf(p: ParsedPattern): string[] {
  let out = [''];
  for (const node of p.nodes) {
    const text = (n: typeof node): string =>
      n.kind === SyntaxKind.Literal
        ? String.fromCodePoint(...n.chars)
        : n.kind === SyntaxKind.Wildcard
        ? 'a'
        : text(n.childNode);
    out =
      node.kind === SyntaxKind.Optional
        ? out.flatMap((s) => [s, s + text(node)])
        : out.map((s) => s + text(node));
    out = out.slice(0, 4);
  }
  return out;
}

const LEET: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
const fullwidth = (s: string) =>
  s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const STICKER = formatStickerToken(7);

function variants(s: string): string[] {
  return [
    s,
    s.toUpperCase(),
    s.replace(/[aeiost]/g, (c) => LEET[c]),
    fullwidth(s),
    s.replace(/(.)/, '$1$1$1'),
    s.split('').join(' '),
  ];
}

function contexts(v: string): string[] {
  return [v, `well ${v} then`, `pre${v}`, `${v}post`, `pre${v}post`, `${STICKER}${v}${STICKER}`];
}

const termPatterns: ParsedPattern[] = [
  ...englishDataset.build().blacklistedTerms.map((term) => term.pattern),
  ...blockedWords.flatMap((word) => {
    try {
      return [parseRawPattern(cleanWord(word))];
    } catch {
      return [];
    }
  }),
];

const corpus = [
  ...termPatterns.flatMap(samplesOf).flatMap(variants).flatMap(contexts),
  ...whitelistWords.flatMap((word) => [word, `a ${word} here`, word.toUpperCase()]),
  'the model works great with these settings and I really like how the lighting turned out',
  'thanks for sharing your prompt, could you post the sampler, steps, cfg scale and seed?',
  '',
];

const prefilterOf = (filter: SimpleProfanityFilter) =>
  Reflect.get(filter, 'anyTermPrefilter') as ((text: string) => boolean) | null;

describe.each([
  ['the shipped lists', {}],
  [
    'a managed list at seed size',
    { moderatorBlocklist: [...blockedWords], moderatorWhitelist: [...whitelistWords] },
  ],
])('the one-alternation prefilter, with %s', (_, options) => {
  const filter = createProfanityFilter(options);
  // The per-term pass alone: what every text went through before the prefilter.
  const perTerm = createProfanityFilter(options);
  Reflect.set(perTerm, 'anyTermPrefilter', null);

  it('masks and analyzes every input exactly as the per-term pass does', () => {
    const prefilter = prefilterOf(filter);
    expect(prefilter, 'no prefilter was built, so this compares the pass with itself').toBeTypeOf(
      'function'
    );

    let skipped = 0;
    let profane = 0;
    const differ: number[] = [];
    corpus.forEach((text, index) => {
      if (!prefilter?.(text)) skipped++;
      const expected = perTerm.analyze(text);
      if (expected.isProfane) profane++;
      const sameClean = filter.clean(text) === perTerm.clean(text);
      const sameAnalysis = JSON.stringify(filter.analyze(text)) === JSON.stringify(expected);
      if (!sameClean || !sameAnalysis) differ.push(index);
    });

    expect(differ, 'inputs (by position) masked differently').toEqual([]);
    // Both sides of the corpus are exercised: texts the prefilter let skip the pass, and texts
    // the pass masks.
    expect(skipped).toBeGreaterThan(100);
    expect(profane).toBeGreaterThan(1000);
  });
});

// After an obscenity bump that moves these internals, masking must slow down, not break.
it('falls back to the per-term pass when the matcher internals are not the expected shape', () => {
  const matcher = Reflect.get(createProfanityFilter(), 'matcher') as RegExpMatcher;
  expect(createAnyTermPrefilter(matcher)).toBeTypeOf('function');
  const renamed = Object.create(matcher);
  Object.defineProperty(renamed, 'blacklistMatcherTransformers', { value: undefined });
  expect(createAnyTermPrefilter(renamed)).toBeNull();
  const reshaped = Object.create(matcher);
  reshaped.applyTransformers = () => ({ transformed: '' });
  expect(createAnyTermPrefilter(reshaped)).toBeNull();
  const notText = Object.create(matcher);
  notText.applyTransformers = () => [[], 42];
  expect(createAnyTermPrefilter(notText)?.('anything')).toBe(true);
});
