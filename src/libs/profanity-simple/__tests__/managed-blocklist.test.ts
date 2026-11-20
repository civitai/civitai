import { describe, expect, it } from 'vitest';
import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { createProfanityFilter, getProfanityFilter } from '~/libs/profanity-simple';
import { sanitizeRenderHtml } from '~/components/RenderHtml/sanitize-render-html';
import { toProfanityBlocklist } from '~/hooks/useBenignPhrases';

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
});

describe('getProfanityFilter', () => {
  it('shares one filter per list version and builds a new one when the version changes', () => {
    const a = getProfanityFilter(null, MANAGED);
    expect(getProfanityFilter(null, { ...MANAGED })).toBe(a);
    expect(getProfanityFilter(null, { ...MANAGED, version: '31:2' })).not.toBe(a);
  });

  it('falls back to the shipped list when a managed entry cannot be parsed', () => {
    const bad = { version: '31:9', words: ['zorblat', 'zor|blat'] };
    expect(() => createProfanityFilter({ moderatorBlocklist: bad.words })).toThrow();
    const filter = getProfanityFilter(null, bad);
    expect(filter.analyze(shippedOnly[0]).isProfane).toBe(true);
  });

  it('keeps the shipped-list filter apart from the managed one', () => {
    expect(getProfanityFilter(null, MANAGED).analyze('zorblat').isProfane).toBe(true);
    expect(getProfanityFilter(null, null).analyze('zorblat').isProfane).toBe(false);
  });
});

describe('comment masking', () => {
  const options = {
    maskProfanity: true,
    allowStickers: false,
    allowCustomStyles: true,
    colorScheme: 'dark' as const,
    withMentions: false,
    thirdPartyAllowed: true,
    host: 'civitai.com',
    ownHosts: ['civitai.com'],
  };

  it('masks with the managed list it is given, and with the shipped list given null', () => {
    const html = '<p>a zorblat here</p>';
    expect(sanitizeRenderHtml(html, { ...options, profanityBlocklist: MANAGED })).not.toContain(
      'zorblat'
    );
    expect(sanitizeRenderHtml(html, { ...options, profanityBlocklist: null })).toContain('zorblat');
  });
});

describe('toProfanityBlocklist', () => {
  it('pairs the served words with their version, and is null without either', () => {
    const words = ['zorblat'];
    expect(
      toProfanityBlocklist({ profanityBlockedWords: words, profanityListVersion: '31:1' })
    ).toEqual({ version: '31:1', words });
    expect(
      toProfanityBlocklist({ profanityBlockedWords: null, profanityListVersion: '31:1' })
    ).toBeNull();
    expect(
      toProfanityBlocklist({ profanityBlockedWords: words, profanityListVersion: null })
    ).toBeNull();
  });
});
