import { describe, expect, it } from 'vitest';
import {
  explainMatches,
  hasNoRecordedMatch,
  highlightSets,
  humanizeCategory,
  sourceLabel,
  promptTesterHref,
} from '../trigger-evidence';

describe('sourceLabel', () => {
  it('maps known sources and passes unknown ones through', () => {
    expect(sourceLabel('Regex')).toBe('Word list');
    expect(sourceLabel('External')).toBe('External moderation');
    expect(sourceLabel('Other')).toBe('Other');
  });
});

describe('humanizeCategory', () => {
  it('turns identifiers into words', () => {
    expect(humanizeCategory('alpha_beta')).toBe('Alpha beta');
    expect(humanizeCategory('alphaBeta')).toBe('Alpha beta');
    expect(humanizeCategory('alpha-beta')).toBe('Alpha beta');
  });
});

describe('explainMatches', () => {
  it('uses matches when present', () => {
    const out = explainMatches({
      matches: [
        { category: 'one', matchedText: 'alpha', matchedField: 'prompt', gateWord: 'beta' },
        { category: 'two', matchedWord: 'gamma', matchedRegex: 'g+' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: 'alpha', field: 'prompt', gateWord: 'beta' });
    expect(out[1]).toMatchObject({ text: 'gamma', regex: 'g+', field: undefined });
  });

  it('falls back to the top-level fields as one match', () => {
    const out = explainMatches({ category: 'one', matchedWord: 'alpha', matchedText: 'alphas' });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('alphas');
  });

  it('returns nothing without a category or text', () => {
    expect(explainMatches({ prompt: 'x' })).toEqual([]);
  });
});

describe('highlightSets', () => {
  it('routes by field and puts gate words in the prompt', () => {
    const sets = highlightSets(
      explainMatches({
        matches: [
          { category: 'a', matchedText: 'alpha', matchedField: 'prompt', gateWord: 'beta' },
          { category: 'b', matchedText: 'gamma', matchedField: 'negativePrompt' },
        ],
      })
    );
    expect(sets.prompt).toEqual(['alpha', 'beta']);
    expect(sets.negativePrompt).toEqual(['gamma']);
  });

  it('highlights both boxes when the field is unknown', () => {
    const sets = highlightSets(explainMatches({ category: 'a', matchedWord: 'alpha' }));
    expect(sets.prompt).toEqual(['alpha']);
    expect(sets.negativePrompt).toEqual(['alpha']);
  });

  it('dedupes', () => {
    const sets = highlightSets([
      { category: 'a', text: 'alpha', field: 'prompt' },
      { category: 'b', text: 'alpha', field: 'prompt' },
    ]);
    expect(sets.prompt).toEqual(['alpha']);
  });
});

describe('hasNoRecordedMatch', () => {
  it('is true only for a prompt with no category and no text', () => {
    expect(hasNoRecordedMatch({ prompt: 'x' })).toBe(true);
    expect(hasNoRecordedMatch({ prompt: 'x', category: 'a' })).toBe(false);
    expect(hasNoRecordedMatch({ prompt: 'x', matchedWord: 'w' })).toBe(false);
    expect(hasNoRecordedMatch({})).toBe(false);
  });
});

describe('promptTesterHref', () => {
  it('encodes prompt and negative prompt', () => {
    const href = promptTesterHref({ prompt: 'a & b', negativePrompt: 'c' });
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/audit/prompt-tester');
    expect(url.searchParams.get('prompt')).toBe('a & b');
    expect(url.searchParams.get('negativePrompt')).toBe('c');
  });

  it('omits an absent negative prompt', () => {
    expect(promptTesterHref({ prompt: 'a' })).not.toContain('negativePrompt');
  });
});
