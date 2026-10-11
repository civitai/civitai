import { describe, expect, it } from 'vitest';
import {
  milestoneShareSchema,
  profileAchievementsSchema,
} from '~/server/schema/creator-journey.schema';

// The input every share lookup takes, from the public preview check to the og card.
describe('milestoneShareSchema', () => {
  it.each(['supernova', 'reach:downloads-10000', 'hidden:vwjxua'])('accepts %s', (milestone) => {
    expect(milestoneShareSchema.safeParse({ userId: 42, milestone }).success).toBe(true);
  });

  it.each(['x', 'score:legend', 'reach:A', "reach:x' OR 1=1", ''])('refuses %s', (milestone) => {
    expect(milestoneShareSchema.safeParse({ userId: 42, milestone }).success).toBe(false);
  });
});

// The tab's input: a shared link's token travels with it so the server can key that one secret card.
describe('profileAchievementsSchema', () => {
  it('keeps a share token', () => {
    expect(profileAchievementsSchema.parse({ userId: 42, spotlight: 'hidden:vwjxua' })).toEqual({
      userId: 42,
      spotlight: 'hidden:vwjxua',
    });
    expect(profileAchievementsSchema.parse({ userId: 42 })).toEqual({ userId: 42 });
  });

  it.each(['x', 'score:legend', "hidden:x' OR 1=1", ''])('refuses %s', (spotlight) => {
    expect(profileAchievementsSchema.safeParse({ userId: 42, spotlight }).success).toBe(false);
  });
});
