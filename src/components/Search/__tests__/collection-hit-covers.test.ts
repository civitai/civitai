import { describe, expect, it } from 'vitest';
import { coversWithinBrowsingLevel } from '~/components/Search/collection-hit-covers';
import { NsfwLevel } from '~/server/common/enums';

const SFW = NsfwLevel.PG | NsfwLevel.PG13;
const img = (id: number, nsfwLevel: number) => ({ id, nsfwLevel });

describe('coversWithinBrowsingLevel', () => {
  it('drops covers above the viewer level, and the unrated srcs with them', () => {
    const hit = {
      id: 1,
      image: img(1, NsfwLevel.X),
      images: [img(2, NsfwLevel.PG), img(3, NsfwLevel.XXX), img(4, NsfwLevel.PG13)],
      srcs: ['a', 'b', 'c'],
    };
    expect(coversWithinBrowsingLevel(hit, SFW)).toEqual({
      id: 1,
      image: null,
      images: [img(2, NsfwLevel.PG), img(4, NsfwLevel.PG13)],
      srcs: [],
    });
  });

  it('drops an unrated cover', () => {
    const hit = { image: null, images: [img(1, 0)], srcs: ['a'] };
    expect(coversWithinBrowsingLevel(hit, SFW)).toEqual({ image: null, images: [], srcs: [] });
  });

  it('keeps every cover the viewer level allows', () => {
    const hit = {
      image: img(1, NsfwLevel.R),
      images: [img(2, NsfwLevel.PG), img(3, NsfwLevel.X)],
      srcs: ['a', 'b'],
    };
    expect(coversWithinBrowsingLevel(hit, SFW | NsfwLevel.R | NsfwLevel.X)).toEqual(hit);
  });
});
