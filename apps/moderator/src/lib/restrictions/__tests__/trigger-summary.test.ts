import { describe, expect, it } from 'vitest';
import { summarizeTriggers } from '../trigger-summary';

const t = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  prompt: 'alpha',
  source: 'Regex',
  ...extra,
});

describe('summarizeTriggers', () => {
  it('counts attempts and distinct prompts', () => {
    const s = summarizeTriggers([
      t('a'),
      t('b'),
      t('c', { negativePrompt: 'beta' }),
      t('d', { prompt: 'gamma' }),
    ]);
    expect(s.total).toBe(4);
    expect(s.distinctPrompts).toBe(3);
  });

  it('ignores triggers without a prompt when counting distinct prompts', () => {
    const s = summarizeTriggers([t('a'), { key: 'b', category: 'scam' }]);
    expect(s.total).toBe(2);
    expect(s.distinctPrompts).toBe(1);
  });

  it('breaks down by recorded category, most common first', () => {
    const s = summarizeTriggers([
      t('a', { category: 'alpha_beta', matchedWord: 'x' }),
      t('b', { category: 'gamma', matchedWord: 'y' }),
      t('c', { category: 'alpha_beta', matchedWord: 'z' }),
    ]);
    expect(s.reasons).toEqual([
      { label: 'Alpha beta', count: 2 },
      { label: 'Gamma', count: 1 },
    ]);
  });

  it('counts a trigger once per distinct category even when several rules matched', () => {
    const s = summarizeTriggers([
      t('a', {
        matches: [
          { category: 'alpha', matchedWord: 'x' },
          { category: 'alpha', matchedWord: 'y' },
          { category: 'beta', matchedWord: 'z' },
        ],
      }),
    ]);
    expect(s.reasons).toEqual([
      { label: 'Alpha', count: 1 },
      { label: 'Beta', count: 1 },
    ]);
  });

  it('labels external moderation by its classifier label', () => {
    const s = summarizeTriggers([
      t('a', { source: 'External', category: 'External', matchedWord: 'some_label' }),
    ]);
    expect(s.reasons).toEqual([{ label: 'Some label', count: 1 }]);
  });

  it('uses re-check categories for unrecorded rows and says when the re-check found nothing', () => {
    const s = summarizeTriggers([t('a'), t('b'), t('c')], {
      a: ['Would block now (Minor)'],
      b: [],
    });
    expect(s.reasons).toEqual([
      { label: 'Match not recorded', count: 1 },
      { label: 'No match with the current list', count: 1 },
      { label: 'Would block now (Minor)', count: 1 },
    ]);
  });

  it('breaks down by source label, naming a missing one', () => {
    const s = summarizeTriggers([t('a'), t('b', { source: 'External' }), t('c', { source: '' })]);
    expect(s.sources).toEqual([
      { label: 'External moderation', count: 1 },
      { label: 'Unknown source', count: 1 },
      { label: 'Word list', count: 1 },
    ]);
  });

  it('reports the span from earliest to latest recorded time', () => {
    const s = summarizeTriggers([
      t('a', { time: '2026-01-02T00:00:00Z' }),
      t('b', { time: '2026-01-01T00:00:00Z' }),
      t('c'),
    ]);
    expect(s.first).toBe('2026-01-01T00:00:00.000Z');
    expect(s.last).toBe('2026-01-02T00:00:00.000Z');
  });

  it('has no span when no trigger has a time', () => {
    const s = summarizeTriggers([t('a')]);
    expect(s.first).toBeUndefined();
    expect(s.last).toBeUndefined();
  });
});
