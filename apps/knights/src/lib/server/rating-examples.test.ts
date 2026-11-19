import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { IMAGE_LOCATION: 'https://cdn.test' } }));

const { EXAMPLES_PER_LEVEL, groupExamples, withExamples } = await import('./rating-examples');

const row = (id: number, nsfwLevel: number) => ({
  id,
  url: `key-${id}`,
  nsfwLevel,
  width: 800,
  height: 1200,
});

describe('rating guide examples', () => {
  it('groups by level in collection order and caps each level', () => {
    const rows = [
      row(1, 1),
      row(2, 4),
      row(3, 1),
      ...Array.from({ length: 10 }, (_, i) => row(10 + i, 2)),
    ];
    const grouped = groupExamples(rows);

    expect(grouped[1].map((e) => e.id)).toEqual([1, 3]);
    expect(grouped[4].map((e) => e.id)).toEqual([2]);
    expect(grouped[2]).toHaveLength(EXAMPLES_PER_LEVEL);
    expect(grouped[2][0]).toEqual({
      id: 10,
      src: 'https://cdn.test/key-10/width=450,optimized=true/key-10.jpeg',
      width: 800,
      height: 1200,
    });
  });

  it('gives a level with no examples an empty list', () => {
    const guide = withExamples([{ level: 1 }, { level: 32 }], groupExamples([row(1, 1)]));

    expect(guide[0].examples.map((e) => e.id)).toEqual([1]);
    expect(guide[1].examples).toEqual([]);
  });
});
