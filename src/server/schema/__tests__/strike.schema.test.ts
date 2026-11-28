import { describe, expect, it } from 'vitest';
import { createStrikeSchema } from '~/server/schema/strike.schema';
import { StrikeReason } from '~/shared/utils/prisma/enums';

const base = { userId: 1, description: 'd' };

// The 0-point Copyright strike: civitai/civitai#10736 (repeat-infringer review).
describe('createStrikeSchema points', () => {
  it('accepts a 0-point Copyright strike, which records the removal without escalating', () => {
    const result = createStrikeSchema.safeParse({
      ...base,
      reason: StrikeReason.Copyright,
      points: 0,
    });
    expect(result.success).toBe(true);
    expect(result.data?.points).toBe(0);
  });

  it.each([StrikeReason.TOSViolation, StrikeReason.ManualModAction, StrikeReason.Scam])(
    'refuses 0 points for %s',
    (reason) => {
      const result = createStrikeSchema.safeParse({ ...base, reason, points: 0 });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['points']);
    }
  );

  it('still accepts a Copyright strike with points a moderator chose', () => {
    expect(
      createStrikeSchema.safeParse({ ...base, reason: StrikeReason.Copyright, points: 2 }).success
    ).toBe(true);
  });
});
