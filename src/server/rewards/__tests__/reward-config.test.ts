import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  invalidateRewardConfigCache,
  MAX_AWARD_AMOUNT,
  MAX_CAP,
  resolveRewardConfig,
  rewardOverrideSchema,
} from '~/server/rewards/reward-config';

// The compiled definition's values. Every fallback below asserts against THIS
// object rather than a repeated literal, so a fallback that lands on some other
// plausible number (the placement bug that produced caps 100x too large) fails
// here instead of passing on a coincidence.
const DEFAULTS = { awardAmount: 10, cap: 30, capOverridable: true } as const;

const findUnique = dbMock.dbRead.keyValue.findUnique;
const storedConfig = (value: unknown) => findUnique.mockResolvedValue({ value });
const resolve = (overrides?: Partial<typeof DEFAULTS>) =>
  resolveRewardConfig('testReward', { ...DEFAULTS, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveRewardConfig', () => {
  it('falls back to the compiled defaults when the row is missing or malformed', async () => {
    for (const value of [null, 42, 'thirty', [], { rewards: 'all of them' }]) {
      invalidateRewardConfigCache();
      findUnique.mockResolvedValue(value === null ? null : { value });

      const config = await resolve();

      expect(config.enabled).toBe(true);
      expect(config.awardAmount).toBe(DEFAULTS.awardAmount);
      expect(config.cap).toBe(DEFAULTS.cap);
    }
  });

  it('honours a well-formed override', async () => {
    storedConfig({ rewards: { testReward: { enabled: false, awardAmount: 4, cap: 8 } } });

    expect(await resolve()).toMatchObject({ enabled: false, awardAmount: 4, cap: 8 });
  });

  it('leaves a reward alone when the row names only other rewards', async () => {
    storedConfig({ rewards: { someOtherReward: { enabled: false } } });

    expect(await resolve()).toMatchObject({
      enabled: true,
      awardAmount: DEFAULTS.awardAmount,
      cap: DEFAULTS.cap,
    });
  });

  it('refuses every out-of-bounds amount and keeps the default instead of zero', async () => {
    for (const awardAmount of [
      -1,
      10.5,
      MAX_AWARD_AMOUNT + 1,
      Number.NaN,
      Infinity,
      '50',
      null,
      { amount: 50 },
    ]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { awardAmount } } });

      const config = await resolve();

      expect(config.awardAmount).toBe(DEFAULTS.awardAmount);
      expect(config.rejected).toContain('awardAmount');
    }
  });

  it('refuses every out-of-bounds cap and keeps the default', async () => {
    for (const cap of [-1, 0.5, MAX_CAP + 1, Number.NaN, '30', true]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { cap } } });

      const config = await resolve();

      expect(config.cap).toBe(DEFAULTS.cap);
      expect(config.rejected).toContain('cap');
    }
  });

  it('accepts the bounds themselves, so the guard is a bound and not an off-by-one', async () => {
    storedConfig({
      rewards: { testReward: { awardAmount: MAX_AWARD_AMOUNT, cap: MAX_CAP } },
    });

    expect(await resolve()).toMatchObject({ awardAmount: MAX_AWARD_AMOUNT, cap: MAX_CAP });
  });

  it('accepts zero, which disables the payout without disabling the reward', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 0, cap: 0 } } });

    expect(await resolve()).toMatchObject({ enabled: true, awardAmount: 0, cap: 0 });
  });

  // The whole point of per-field rejection: an operator who turns a reward off
  // and fat-fingers the cap in the same edit must still get the reward turned
  // off. Dropping the whole entry on one bad field would silently re-enable it.
  it('keeps the valid fields of an entry whose other fields are refused', async () => {
    storedConfig({
      rewards: { testReward: { enabled: false, awardAmount: 999999, cap: 8 } },
    });

    const config = await resolve();

    expect(config.enabled).toBe(false);
    expect(config.cap).toBe(8);
    expect(config.awardAmount).toBe(DEFAULTS.awardAmount);
    expect(config.rejected).toEqual(['awardAmount']);
  });

  it('treats a non-object entry as no override at all', async () => {
    storedConfig({ rewards: { testReward: 'off' } });

    expect(await resolve()).toMatchObject({
      enabled: true,
      awardAmount: DEFAULTS.awardAmount,
      cap: DEFAULTS.cap,
    });
  });

  it('refuses a non-boolean `enabled` rather than reading it as truthy', async () => {
    for (const enabled of ['false', 0, 'no']) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { enabled } } });

      const config = await resolve();

      expect(config.enabled).toBe(true);
      expect(config.rejected).toContain('enabled');
    }
  });

  // One number cannot say whether it means the daily cap or the monthly one.
  it('refuses a cap override for a reward whose cap is a multi-entry table', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4, cap: 8 } } });

    const config = await resolve({ capOverridable: false, cap: undefined });

    expect(config.cap).toBeUndefined();
    expect(config.rejected).toContain('cap');
    // The refusal is scoped to the cap — the rest of the entry still applies.
    expect(config.awardAmount).toBe(4);
  });
});

describe('reward config cache', () => {
  it('reads the row once per TTL, not once per grant', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });

    for (let i = 0; i < 25; i++) await resolve();

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('picks up a change within the stated 60s window', async () => {
    vi.useFakeTimers();
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });
    expect((await resolve()).awardAmount).toBe(4);

    storedConfig({ rewards: { testReward: { awardAmount: 7 } } });
    vi.advanceTimersByTime(59_000);
    expect((await resolve()).awardAmount).toBe(4);

    vi.advanceTimersByTime(2_000);
    expect((await resolve()).awardAmount).toBe(7);
  });

  it('takes a change immediately when the cache is invalidated', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });
    expect((await resolve()).awardAmount).toBe(4);

    storedConfig({ rewards: { testReward: { awardAmount: 7 } } });
    invalidateRewardConfigCache();

    expect((await resolve()).awardAmount).toBe(7);
  });

  // No negative caching: a transient KeyValue blip must not pin every reward to
  // its compiled default for a full TTL.
  it('does not cache a failed read', async () => {
    findUnique.mockRejectedValueOnce(new Error('KeyValue unavailable'));

    const first = await resolve();
    expect(first.awardAmount).toBe(DEFAULTS.awardAmount);

    storedConfig({ rewards: { testReward: { awardAmount: 7 } } });
    expect((await resolve()).awardAmount).toBe(7);
  });

  it('never throws out of a reward grant, whatever the row read does', async () => {
    findUnique.mockRejectedValue(new Error('KeyValue unavailable'));

    await expect(resolve()).resolves.toMatchObject({
      enabled: true,
      awardAmount: DEFAULTS.awardAmount,
      cap: DEFAULTS.cap,
    });
  });
});

describe('rewardOverrideSchema', () => {
  // The admin mutation validates writes with this same schema. If it stopped
  // being the single definition, what can be stored and what gets honoured
  // would drift apart.
  it('rejects at write time exactly what the read path refuses', () => {
    expect(rewardOverrideSchema.safeParse({ awardAmount: MAX_AWARD_AMOUNT + 1 }).success).toBe(
      false
    );
    expect(rewardOverrideSchema.safeParse({ cap: MAX_CAP + 1 }).success).toBe(false);
    expect(rewardOverrideSchema.safeParse({ awardAmount: 10.5 }).success).toBe(false);
    expect(rewardOverrideSchema.safeParse({ cap: -1 }).success).toBe(false);
    expect(rewardOverrideSchema.safeParse({ enabled: false, awardAmount: 4, cap: 8 }).success).toBe(
      true
    );
  });
});
