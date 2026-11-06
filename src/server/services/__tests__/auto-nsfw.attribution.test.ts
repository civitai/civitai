import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProfanitySimple from '~/libs/profanity-simple';

// A stand-in filter: any text holding the placeholder token counts as a match, and so does a phrase
// that only exists once the two fields are joined.
const TOKEN = 'PLACEHOLDER_TOKEN';
const SPANNING = ['PLACEHOLDER_HALF_A', 'PLACEHOLDER_HALF_B'] as const;
vi.mock('~/libs/profanity-simple', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfanitySimple>()),
  createProfanityFilter: () => ({
    evaluateContent: (text: string) => {
      const matchCount = text.split(TOKEN).length - 1 + (text.includes(SPANNING.join(' ')) ? 1 : 0);
      return {
        shouldMarkNSFW: matchCount > 0,
        reason: 'placeholder reason',
        suggestedLevel: 1,
        metrics: { matchCount, uniqueWords: matchCount, totalWords: 1, density: 0 },
        matchedWords: matchCount ? [TOKEN] : [],
      };
    },
  }),
}));

import { autoNsfwTextHash, evaluateAutoNsfw } from '~/server/services/auto-nsfw';

const evaluate = (name: string, description: string) =>
  evaluateAutoNsfw({ name, description, alreadyNsfw: false, lockedProperties: [] });

beforeEach(() => vi.clearAllMocks());

describe('evaluateAutoNsfw attribution', () => {
  it.each([
    ['name', `a ${TOKEN}`, 'clean', ['name']],
    ['description', 'clean', `b ${TOKEN}`, ['description']],
    ['name and the description', TOKEN, TOKEN, ['name', 'description']],
  ])('attributes a match in the %s', (_, name, description, fields) => {
    expect(evaluate(name, description)?.attribution).toStrictEqual({
      fields,
      category: 'mature-language',
      textHash: autoNsfwTextHash(name, description),
    });
  });

  it('carries no matched text, only the fields, the category and a hash', () => {
    const result = evaluate(TOKEN, 'clean');
    expect(JSON.stringify(result?.attribution)).not.toContain(TOKEN);
  });

  it('names no field when only the joined text matches; the owner then gets the plain message', () => {
    const result = evaluate(SPANNING[0], SPANNING[1]);
    expect(result?.attribution.fields).toEqual([]);
  });

  it('a clean pair sets nothing', () => {
    expect(evaluate('clean', 'clean')).toBeNull();
  });

  it('the hash changes when either field does', () => {
    const base = autoNsfwTextHash('n', 'd');
    expect(autoNsfwTextHash('n2', 'd')).not.toBe(base);
    expect(autoNsfwTextHash('n', 'd2')).not.toBe(base);
    // The two fields cannot be shifted into each other to collide.
    expect(autoNsfwTextHash('n d', '')).not.toBe(autoNsfwTextHash('n', ' d'));
  });
});
