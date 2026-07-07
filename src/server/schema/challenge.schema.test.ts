import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_MAX_INITIAL_PRIZE,
  CHALLENGE_MIN_ENTRY_FEE,
} from '~/shared/constants/challenge.constants';
import { prizeSchema, userChallengeUpsertSchema } from '~/server/schema/challenge.schema';

// Regression guard: negative money/quantity values must never validate — a negative amount
// flowing into a Buzz transaction is a grant-instead-of-charge vector (has bitten us before).

describe('prizeSchema floors', () => {
  it('rejects negative buzz / points', () => {
    expect(prizeSchema.safeParse({ buzz: -1, points: 0 }).success).toBe(false);
    expect(prizeSchema.safeParse({ buzz: 0, points: -1 }).success).toBe(false);
    expect(prizeSchema.safeParse({ buzz: 100, points: 5 }).success).toBe(true);
  });
});

describe('userChallengeUpsertSchema money/quantity floors', () => {
  const valid = {
    title: 'A valid challenge title',
    theme: 'Neon',
    coverImage: { url: '123e4567-e89b-12d3-a456-426614174000' },
    judgeId: 1,
    judgingCategories: [{ key: 'theme', label: 'Theme', criteria: 'Fits the theme.', weight: 100 }],
    entryFee: CHALLENGE_MIN_ENTRY_FEE,
    initialPrizeBuzz: 0,
    prizeDistribution: [50, 30, 20],
    maxEntriesPerUser: 5,
    startsAt: new Date('2026-08-01T00:00:00Z'),
    endsAt: new Date('2026-08-08T00:00:00Z'),
  };

  it('accepts a valid payload', () => {
    expect(userChallengeUpsertSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects entry fee below the minimum (incl. negative)', () => {
    expect(userChallengeUpsertSchema.safeParse({ ...valid, entryFee: -50 }).success).toBe(false);
    expect(userChallengeUpsertSchema.safeParse({ ...valid, entryFee: 0 }).success).toBe(false);
    expect(
      userChallengeUpsertSchema.safeParse({ ...valid, entryFee: CHALLENGE_MIN_ENTRY_FEE - 1 }).success
    ).toBe(false);
  });

  it('rejects negative or over-cap initial prize', () => {
    expect(userChallengeUpsertSchema.safeParse({ ...valid, initialPrizeBuzz: -1 }).success).toBe(false);
    expect(
      userChallengeUpsertSchema.safeParse({ ...valid, initialPrizeBuzz: CHALLENGE_MAX_INITIAL_PRIZE + 1 })
        .success
    ).toBe(false);
  });

  it('rejects negative judgeId and non-positive limits', () => {
    expect(userChallengeUpsertSchema.safeParse({ ...valid, judgeId: -1 }).success).toBe(false);
    expect(userChallengeUpsertSchema.safeParse({ ...valid, maxEntriesPerUser: 0 }).success).toBe(false);
    expect(userChallengeUpsertSchema.safeParse({ ...valid, maxParticipants: 0 }).success).toBe(false);
  });

  it('rejects a negative prize-distribution slice', () => {
    expect(
      userChallengeUpsertSchema.safeParse({ ...valid, prizeDistribution: [120, -10, -10] }).success
    ).toBe(false);
  });
});
