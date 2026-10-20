import { describe, expect, it } from 'vitest';
import {
  createStorylineSchema,
  storylinePathSchema,
  updateStorylineSchema,
} from '~/server/schema/storyline.schema';
import { NsfwLevel } from '~/server/common/enums';

describe('storyline cover and banner picks', () => {
  const create = { postId: 1, title: 'A story', maxNsfwLevel: NsfwLevel.R };

  it('takes an image id, or null to clear one, on create and update', () => {
    for (const schema of [createStorylineSchema, updateStorylineSchema]) {
      const base = schema === createStorylineSchema ? create : { id: 10 };
      for (const field of ['coverImageId', 'heroImageId']) {
        expect(schema.safeParse({ ...base, [field]: 5 }).success).toBe(true);
        expect(schema.safeParse({ ...base, [field]: null }).success).toBe(true);
        expect(schema.safeParse({ ...base, [field]: 0 }).success).toBe(false);
        expect(schema.safeParse({ ...base, [field]: 1.5 }).success).toBe(false);
      }
    }
  });

  it.each([
    [0, true],
    [100, true],
    [-1, false],
    [101, false],
    [50.5, false],
  ])('takes a banner focus of %s: %s', (heroImagePosition, ok) => {
    expect(updateStorylineSchema.safeParse({ id: 10, heroImagePosition }).success).toBe(ok);
    expect(createStorylineSchema.safeParse({ ...create, heroImagePosition }).success).toBe(ok);
  });
});

describe('the way in to a reading path', () => {
  const path = (via: number[]) => storylinePathSchema.safeParse({ chapterId: 5, via });

  // A chapter id past Postgres int4 would fail the path query's int[] cast for everyone who
  // opens the link, so it is refused at the edge.
  it('refuses a chapter id past int4, and takes the largest one', () => {
    expect(path([3_000_000_000]).success).toBe(false);
    expect(path([2_147_483_647]).success).toBe(true);
  });

  it('refuses more ids than a path has chapters', () => {
    expect(path(Array.from({ length: 200 }, (_, i) => i + 1)).success).toBe(true);
    expect(path(Array.from({ length: 201 }, (_, i) => i + 1)).success).toBe(false);
  });
});
