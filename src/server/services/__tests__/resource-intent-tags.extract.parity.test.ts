import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  compareCodePoints,
  matchVocabularyKeys,
  TAG_MAX_SEGMENT_TOKENS,
  TAG_STOPWORDS,
  tagKeys,
  tagKeySets,
  tagSegments,
} from '~/server/services/resource-intent-tags/extract';
import { RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS } from '~/server/services/resource-intent-tags/spec';

/**
 * Parity: the TypeScript extractor against the offline prototype's own output. Every expected value
 * in the fixture came from running the prototype's Python functions on these synthetic prompts, so
 * never edit the fixture to make this pass; regenerate it from the prototype or fix the port.
 */
type Case = {
  prompt: string;
  segments: string[][];
  segmentKeys: string[];
  gramKeys: string[];
  keys: string[];
  matches: string[];
};
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-tags-extract-golden.json'), 'utf8')
) as { maxTokens: number; stopwords: string[]; vocabulary: string[]; cases: Case[] };

const sorted = (s: Iterable<string>) => [...s].sort(compareCodePoints);

describe('resource-intent-tags extractor parity with the prototype', () => {
  it('the fixture is the one this test was written for', () => {
    expect(golden.cases.length).toBe(53);
    expect(golden.cases.filter((c) => c.keys.length === 0).length).toBe(4);
    expect(golden.cases.reduce((n, c) => n + c.matches.length, 0)).toBe(63);
  });

  it('covers every prompt the spec hash fingerprints', () => {
    const prompts = new Set(golden.cases.map((c) => c.prompt));
    expect(RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS.filter((p) => !prompts.has(p))).toEqual([]);
  });

  it('uses the prototype constants', () => {
    expect(TAG_MAX_SEGMENT_TOKENS).toBe(golden.maxTokens);
    expect(sorted(TAG_STOPWORDS)).toEqual(golden.stopwords);
  });

  it.each(golden.cases.map((c, i) => [i, c] as const))(
    'case %i: segments, keys and vocabulary matches equal the prototype',
    (_i, c) => {
      const { segment, gram } = tagKeySets(c.prompt);
      expect({
        segments: tagSegments(c.prompt),
        segmentKeys: sorted(segment),
        gramKeys: sorted(gram),
        keys: sorted(tagKeys(c.prompt)),
        matches: matchVocabularyKeys(c.prompt, new Set(golden.vocabulary)),
      }).toEqual({
        segments: c.segments,
        segmentKeys: c.segmentKeys,
        gramKeys: c.gramKeys,
        keys: c.keys,
        matches: c.matches,
      });
    }
  );
});

describe('compareCodePoints', () => {
  it('orders by code point where UTF-16 order differs', () => {
    const astral = String.fromCodePoint(0x20000);
    const bmpHigh = String.fromCodePoint(0xfa0e);
    expect([astral, bmpHigh].sort()).toEqual([astral, bmpHigh]);
    expect([astral, bmpHigh].sort(compareCodePoints)).toEqual([bmpHigh, astral]);
    expect(['ab', 'a', 'b', ''].sort(compareCodePoints)).toEqual(['', 'a', 'ab', 'b']);
  });
});
