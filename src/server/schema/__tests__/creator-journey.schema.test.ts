import { describe, expect, it } from 'vitest';
import { milestoneShareSchema } from '~/server/schema/creator-journey.schema';

// The input every share lookup takes, from the public preview check to the og card.
describe('milestoneShareSchema', () => {
  it.each(['supernova', 'reach:downloads-10000', 'hidden:vwjxua'])('accepts %s', (milestone) => {
    expect(milestoneShareSchema.safeParse({ userId: 42, milestone }).success).toBe(true);
  });

  it.each(['x', 'score:legend', 'reach:A', "reach:x' OR 1=1", ''])('refuses %s', (milestone) => {
    expect(milestoneShareSchema.safeParse({ userId: 42, milestone }).success).toBe(false);
  });
});
