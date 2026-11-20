import { describe, expect, it } from 'vitest';
import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { createProfanityFilter, getProfanityFilter } from '~/libs/profanity-simple';

// Synthetic tokens only: this file is public, and so is the list the shipped words come from.
const MANAGED = { version: '31:1', words: ['zorblat'] };

const shipped = createProfanityFilter();
const managed = createProfanityFilter({ moderatorBlocklist: MANAGED.words });

/** Shipped entries that only the shipped list catches (not the library's own English dataset). */
const shippedOnly = blockedWords
  .filter(isUsableBlockedEntry)
  .map((word) => cleanWord(word).replace(/\|/g, ''))
  .filter((word) => shipped.analyze(word).isProfane && !managed.analyze(word).isProfane);

describe('a managed blocked list', () => {
  it('masks a word the shipped list does not carry', () => {
    expect(shipped.clean('a zorblat here')).toBe('a zorblat here');
    expect(managed.clean('a zorblat here')).not.toContain('zorblat');
  });

  it('REPLACES the shipped list, so removing a shipped word unmasks it', () => {
    expect(shippedOnly.length).toBeGreaterThan(0);
  });

  // No-change test: it passes with the feature reverted too. It guards the fallback, not the feature.
  it('null means the shipped list', () => {
    const fallback = createProfanityFilter({ moderatorBlocklist: null });
    for (const word of shippedOnly) expect(fallback.analyze(word).isProfane).toBe(true);
  });
});

describe('getProfanityFilter', () => {
  it('shares one filter per list version and builds a new one when the version changes', () => {
    const a = getProfanityFilter(null, MANAGED);
    expect(getProfanityFilter(null, { ...MANAGED })).toBe(a);
    expect(getProfanityFilter(null, { ...MANAGED, version: '31:2' })).not.toBe(a);
  });

  it('keeps the shipped-list filter apart from the managed one', () => {
    expect(getProfanityFilter(null, MANAGED).analyze('zorblat').isProfane).toBe(true);
    expect(getProfanityFilter(null, null).analyze('zorblat').isProfane).toBe(false);
  });
});
