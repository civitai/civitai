import { describe, expect, it } from 'vitest';
import { createStorylineSchema, updateStorylineSchema } from '~/server/schema/storyline.schema';
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
