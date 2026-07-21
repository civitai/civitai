import { describe, expect, it } from 'vitest';
import {
  upsertChallengeEventSchema,
  getInfiniteChallengesSchema,
} from '~/server/schema/challenge.schema';

describe('challenge event schema', () => {
  const base = {
    title: 'Summer Fest',
    startDate: new Date('2026-07-01'),
    endDate: new Date('2026-08-31'),
  };

  it('accepts an optional coverImage object', () => {
    const parsed = upsertChallengeEventSchema.parse({
      ...base,
      coverImage: { id: 123, url: '123e4567-e89b-12d3-a456-426614174000', nsfwLevel: 1 },
    });
    expect(parsed.coverImage?.id).toBe(123);
  });

  it('accepts a null coverImage', () => {
    const parsed = upsertChallengeEventSchema.parse({ ...base, coverImage: null });
    expect(parsed.coverImage).toBeNull();
  });

  it('parses without coverImage', () => {
    const parsed = upsertChallengeEventSchema.parse(base);
    expect(parsed.coverImage).toBeUndefined();
  });

  it('accepts challengeEventId on the infinite challenges filter', () => {
    const parsed = getInfiniteChallengesSchema.parse({ challengeEventId: 42 });
    expect(parsed.challengeEventId).toBe(42);
  });
});
