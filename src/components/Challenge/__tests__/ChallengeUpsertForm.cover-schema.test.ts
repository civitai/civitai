import { describe, expect, it } from 'vitest';
import { challengeCoverImageSchema } from '../ChallengeUpsertForm';

describe('the challenge form cover', () => {
  it('🔴 accepts the stored cover sent back with its id and no url', () => {
    expect(challengeCoverImageSchema.safeParse({ id: 80, url: '' }).success).toBe(true);
  });

  it('still requires a cover (control)', () => {
    expect(challengeCoverImageSchema.safeParse({ url: '' }).success).toBe(false);
    expect(challengeCoverImageSchema.safeParse(undefined).success).toBe(false);
  });
});
