import { describe, expect, it } from 'vitest';
import {
  explainMatches,
  hasNoRecordedMatch,
  highlightSets,
  humanizeCategory,
  sourceLabel,
  promptTesterHref,
  prefillInput,
  isMissingFromText,
  MAX_PREFILL_URL_LENGTH,
  isoTriggerTime,
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
  it('shows an external label as the category, not as text from the prompt', () => {
    const out = explainMatches({
      prompt: 'some prompt',
      category: 'external',
      matchedWord: 'flagged label',
    });
    expect(out).toEqual([
      {
        category: 'flagged label',
        text: undefined,
        regex: undefined,
        field: undefined,
        gateWord: undefined,
      },
    ]);
    expect(isMissingFromText(out[0], { prompt: 'some prompt' })).toBe(false);
    expect(highlightSets(out)).toEqual({ prompt: [], negativePrompt: [] });
  });

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

  it('counts a row with only a regex or gate word', () => {
    expect(explainMatches({ matchedRegex: 'a+' })).toHaveLength(1);
    expect(explainMatches({ gateWord: 'beta' })).toHaveLength(1);
    expect(hasNoRecordedMatch({ prompt: 'x', matchedRegex: 'a+' })).toBe(false);
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
    const { href, prefilled } = promptTesterHref({ prompt: 'a & b', negativePrompt: 'c' });
    const url = new URL(href, 'http://x');
    expect(prefilled).toBe(true);
    expect(url.pathname).toBe('/audit/prompt-tester');
    expect(url.searchParams.get('prompt')).toBe('a & b');
    expect(url.searchParams.get('negativePrompt')).toBe('c');
  });

  it('omits an absent negative prompt', () => {
    expect(promptTesterHref({ prompt: 'a' }).href).not.toContain('negativePrompt');
  });

  it('links without a prefill when the encoded URL would be too long', () => {
    const { href, prefilled } = promptTesterHref({ prompt: 'é'.repeat(MAX_PREFILL_URL_LENGTH) });
    expect(prefilled).toBe(false);
    expect(href).toBe('/audit/prompt-tester');
  });
});

describe('prefillInput', () => {
  it('passes a plain prompt through', () => {
    expect(prefillInput('a quiet landscape')).toBe('a quiet landscape');
  });

  it('uses the JSON array form for a negative prompt', () => {
    expect(JSON.parse(prefillInput('a', 'b'))).toEqual([{ prompt: 'a', negativePrompt: 'b' }]);
  });

  it('uses the JSON array form when the prompt starts with a bracket', () => {
    const out = prefillInput('  [alpha:0.5] beta');
    expect(JSON.parse(out)).toEqual([{ prompt: '  [alpha:0.5] beta' }]);
  });
});

describe('isMissingFromText', () => {
  const texts = { prompt: 'Alpha beta', negativePrompt: 'gamma' };

  it('is false when the text is found, ignoring case', () => {
    expect(isMissingFromText({ text: 'alpha', field: 'prompt' }, texts)).toBe(false);
  });

  it('checks only the matched field', () => {
    expect(isMissingFromText({ text: 'gamma', field: 'prompt' }, texts)).toBe(true);
    expect(isMissingFromText({ text: 'gamma', field: 'negativePrompt' }, texts)).toBe(false);
  });

  it('checks both fields when the field is unknown', () => {
    expect(isMissingFromText({ text: 'gamma' }, texts)).toBe(false);
    expect(isMissingFromText({ text: 'delta' }, texts)).toBe(true);
  });

  it('has nothing to find without a text', () => {
    expect(isMissingFromText({ field: 'prompt' }, texts)).toBe(false);
  });
});

describe('isoTriggerTime', () => {
  it('reads an unzoned ClickHouse timestamp as UTC', () => {
    expect(isoTriggerTime('2026-10-19 21:13:05')).toBe('2026-10-19T21:13:05.000Z');
  });

  it('keeps an ISO timestamp as it is', () => {
    expect(isoTriggerTime('2026-10-19T21:21:53.540Z')).toBe('2026-10-19T21:21:53.540Z');
  });

  it('passes through missing and unparseable values', () => {
    expect(isoTriggerTime(undefined)).toBeUndefined();
    expect(isoTriggerTime('not a time')).toBe('not a time');
  });
});
