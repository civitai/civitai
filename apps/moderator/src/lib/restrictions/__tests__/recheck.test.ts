import { describe, expect, it } from 'vitest';
import { planRecheck, recheckCategories } from '../recheck';

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
