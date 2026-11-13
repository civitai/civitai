import { describe, expect, it } from 'vitest';
import {
  countNotBlocking,
  normalisedDiffers,
  planRecheck,
  recheckCategories,
  recheckReasonLabels,
  recheckResult,
} from '../recheck';

const t = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  prompt: 'alpha',
  source: 'Regex',
  ...extra,
});

describe('planRecheck', () => {
  it('queues one input per distinct prompt pair and maps every trigger to it', () => {
    const plan = planRecheck([
      t('a'),
      t('b'),
      t('c', { negativePrompt: 'beta' }),
      t('d', { negativePrompt: 'beta' }),
    ]);
    expect(plan.inputs).toEqual([{ prompt: 'alpha' }, { prompt: 'alpha', negativePrompt: 'beta' }]);
    expect(plan.byKey).toEqual({ a: 0, b: 0, c: 1, d: 1 });
  });

  it('skips triggers that already carry a recorded match', () => {
    const plan = planRecheck([t('a', { category: 'gamma', matchedWord: 'x' }), t('b')]);
    expect(plan.byKey).toEqual({ b: 0 });
  });

  it('skips external moderation and triggers without a prompt', () => {
    const plan = planRecheck([t('a', { source: 'External' }), { key: 'b', category: 'scam' }]);
    expect(plan.inputs).toEqual([]);
    expect(plan.byKey).toEqual({});
  });

  it('does not conflate an absent negative prompt with a different one', () => {
    const plan = planRecheck([t('a'), t('b', { negativePrompt: '' })]);
    expect(plan.inputs).toHaveLength(1);
  });
});

describe('recheckCategories', () => {
  it('lists each category once, across both prompts, in order of appearance', () => {
    expect(
      recheckCategories({
        prompt: [
          { text: 'a', category: null },
          { text: 'b', category: 'nsfw' },
          { text: 'c', category: 'minor' },
          { text: 'd', category: 'nsfw' },
        ],
        negativePrompt: [
          { text: 'e', category: 'minor' },
          { text: 'f', category: 'poi' },
        ],
      })
    ).toEqual(['nsfw', 'minor', 'poi']);
  });

  it('is empty when nothing is flagged', () => {
    expect(
      recheckCategories({ prompt: [{ text: 'a', category: null }], negativePrompt: null })
    ).toEqual([]);
  });
});

const seg = (category: 'nsfw' | 'blocked' | 'minor' | null) => ({ text: 'a', category });

describe('recheckResult', () => {
  it('would block when the audit calls the prompt inappropriate', () => {
    expect(
      recheckResult({ includesInappropriate: true, prompt: [seg('nsfw')], negativePrompt: null })
        .wouldBlock
    ).toBe(true);
  });

  it('would block on a blocked-list hit in either prompt', () => {
    const base = { includesInappropriate: false };
    expect(
      recheckResult({ ...base, prompt: [seg('blocked')], negativePrompt: null }).wouldBlock
    ).toBe(true);
    expect(
      recheckResult({ ...base, prompt: [seg(null)], negativePrompt: [seg('blocked')] }).wouldBlock
    ).toBe(true);
  });

  it('would not block on terms that do not block on their own', () => {
    expect(
      recheckResult({ includesInappropriate: false, prompt: [seg('nsfw')], negativePrompt: null })
        .wouldBlock
    ).toBe(false);
  });

  it('drops the audit-only flag from the shipped result', () => {
    const result = recheckResult({
      includesInappropriate: false,
      prompt: [],
      negativePrompt: null,
    });
    expect(Object.keys(result).sort()).toEqual(['negativePrompt', 'prompt', 'wouldBlock']);
  });
});

describe('recheckReasonLabels', () => {
  const names = (c: string) => c.toUpperCase();
  it('names the categories when it would block', () => {
    const r = recheckResult({
      includesInappropriate: true,
      prompt: [seg('minor'), seg('nsfw')],
      negativePrompt: null,
    });
    expect(recheckReasonLabels(r, names)).toEqual(['Would block now (MINOR, NSFW)']);
  });

  it('says would not block when only non-blocking terms were found', () => {
    const r = recheckResult({
      includesInappropriate: false,
      prompt: [seg('nsfw')],
      negativePrompt: null,
    });
    expect(recheckReasonLabels(r, names)).toEqual(['Would not block now']);
  });

  it('is empty when nothing was found', () => {
    const r = recheckResult({
      includesInappropriate: false,
      prompt: [seg(null)],
      negativePrompt: null,
    });
    expect(recheckReasonLabels(r, names)).toEqual([]);
  });
});

describe('normalisedDiffers', () => {
  it('is false when the segments rebuild the raw text exactly', () => {
    expect(
      normalisedDiffers(
        [
          { text: 'al', category: null },
          { text: 'pha', category: 'nsfw' },
        ],
        'alpha'
      )
    ).toBe(false);
  });

  it('is true when normalisation changed the text', () => {
    expect(normalisedDiffers([{ text: 'alpha', category: null }], 'Alpha &amp; beta')).toBe(true);
  });
});

describe('countNotBlocking', () => {
  const r = (wouldBlock: boolean) => ({ prompt: [], negativePrompt: null, wouldBlock });
  it('counts re-checked triggers the current list would not block, including ones with no hits', () => {
    expect(
      countNotBlocking({ results: [r(true), r(false)], byKey: { a: 0, b: 1, c: 1, d: 1 } })
    ).toBe(3);
  });

  it('is zero without a re-check', () => {
    expect(countNotBlocking(undefined)).toBe(0);
  });
});
