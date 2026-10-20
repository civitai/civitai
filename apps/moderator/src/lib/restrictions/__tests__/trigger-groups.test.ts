import { describe, expect, it } from 'vitest';
import { attemptTimes, formatSpan, groupRepeats, repeatSpanMs } from '../trigger-groups';

const t = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  prompt: 'alpha',
  source: 'Regex',
  ...extra,
});

describe('groupRepeats', () => {
  it('merges consecutive identical attempts and keeps their keys and positions', () => {
    const groups = groupRepeats([t('1-0'), t('1-1'), t('1-2', { prompt: 'beta' }), t('1-3')]);
    expect(groups.map((g) => g.triggers.map((x) => x.key))).toEqual([
      ['1-0', '1-1'],
      ['1-2'],
      ['1-3'],
    ]);
    expect(groups.map((g) => g.start)).toEqual([0, 2, 3]);
  });

  it('does not merge non-consecutive repeats', () => {
    const groups = groupRepeats([t('a'), t('b', { prompt: 'beta' }), t('c')]);
    expect(groups).toHaveLength(3);
  });

  it.each([
    ['negative prompt', { negativePrompt: 'gamma' }],
    ['source', { source: 'External' }],
    ['input images', { inputImages: ['u1'] }],
    ['input video', { inputVideo: 'v1' }],
    ['image id', { imageId: 5 }],
    ['remix source', { remixOfId: 9 }],
    ['category', { category: 'delta' }],
  ])('separates attempts that differ in %s', (_name, extra) => {
    expect(groupRepeats([t('a'), t('b', extra)])).toHaveLength(2);
  });

  it('compares input images by content, not reference', () => {
    const groups = groupRepeats([
      t('a', { inputImages: ['u1', 'u2'] }),
      t('b', { inputImages: ['u1', 'u2'] }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('treats an absent field and an empty one as the same', () => {
    expect(groupRepeats([t('a'), t('b', { negativePrompt: '', inputImages: [] })])).toHaveLength(1);
  });

  it('never merges triggers that are not prompts', () => {
    const scam = { key: 'x', category: 'scam', text: 'same' };
    expect(groupRepeats([scam, { ...scam, key: 'y' }])).toHaveLength(2);
  });

  it('returns nothing for no triggers', () => {
    expect(groupRepeats([])).toEqual([]);
  });
});

describe('repeatSpanMs', () => {
  it('is the distance between earliest and latest time regardless of order', () => {
    expect(
      repeatSpanMs([
        { time: '2026-01-01T00:00:08Z' },
        { time: '2026-01-01T00:00:00Z' },
        { time: '2026-01-01T00:00:03Z' },
      ])
    ).toBe(8000);
  });

  it('is null when fewer than two valid times exist', () => {
    expect(repeatSpanMs([{ time: '2026-01-01T00:00:00Z' }, {}])).toBeNull();
    expect(repeatSpanMs([{ time: 'nope' }, { time: 'nope' }])).toBeNull();
  });
});

describe('formatSpan', () => {
  it.each([
    [0, 'under a second'],
    [8000, '8s'],
    [90_000, '1m 30s'],
    [3_600_000, '1h'],
    [3_660_000, '1h 1m'],
    [90_000_000, '1d 1h'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatSpan(ms)).toBe(text);
  });
});

describe('attemptTimes', () => {
  it('orders attempts oldest first with offsets from the earliest', () => {
    const out = attemptTimes([
      { key: 'b', time: '2026-01-01T00:00:08.000Z' },
      { key: 'a', time: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(out).toEqual([
      { key: 'a', time: '2026-01-01T00:00:00.000Z', offset: 0 },
      { key: 'b', time: '2026-01-01T00:00:08.000Z', offset: 8000 },
    ]);
  });

  it('puts attempts without a time last, with no offset', () => {
    const out = attemptTimes([{ key: 'x' }, { key: 'a', time: '2026-01-01T00:00:00.000Z' }]);
    expect(out.map((a) => [a.key, a.offset])).toEqual([
      ['a', 0],
      ['x', null],
    ]);
  });
});
