import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { REWARD_CONFIG_CONFLICT } from '~/shared/constants/reward-config.constants';
import {
  configFromStoredValue,
  getStoredRewardConfig,
  invalidateRewardConfigCache,
  MAX_AWARD_AMOUNT,
  MAX_CAP,
  resolveFromConfig,
  resolveRewardConfig,
  REWARD_CONFIG_KEY,
  rewardOverrideSchema,
  setRewardConfig,
  storedViewOf,
} from '~/server/rewards/reward-config';
import { buildRewardsPayload } from '~/components/Rewards/reward-config-panel.utils';

// The compiled definition's values. Every fallback below asserts against THIS
// object rather than a repeated literal, so a fallback that lands on some other
// plausible number (the placement bug that produced caps 100x too large) fails
// here instead of passing on a coincidence.
const DEFAULTS = { awardAmount: 10, cap: 30, capOverridable: true } as const;

const findUnique = dbMock.dbRead.keyValue.findUnique;
const findUniqueWrite = dbMock.dbWrite.keyValue.findUnique;
// The hot read path (`resolveRewardConfig`) uses the replica; the version guard
// and the editor read use the primary. Seeding both keeps every test about the
// behaviour under test rather than about which client it happened to reach for.
const storedConfig = (value: unknown) => {
  findUnique.mockResolvedValue({ value });
  findUniqueWrite.mockResolvedValue({ value });
};
const resolve = (overrides?: Partial<typeof DEFAULTS>) =>
  resolveRewardConfig('testReward', { ...DEFAULTS, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  findUnique.mockResolvedValue(null);
  findUniqueWrite.mockResolvedValue(null);
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
      // The other direction, which the rest of this file does not pin: a refused
      // sibling must not take the reward down either. Everything else here is
      // about fail-open; this is the fail-closed edge of the same function.
      expect(config.enabled).toBe(true);
    }
  });

  it('refuses every out-of-bounds cap and keeps the default', async () => {
    for (const cap of [-1, 0.5, MAX_CAP + 1, Number.NaN, '30', true]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { cap } } });

      const config = await resolve();

      expect(config.cap).toBe(DEFAULTS.cap);
      expect(config.rejected).toContain('cap');
      expect(config.enabled).toBe(true);
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

  // `{"dailyBoost": false}` is the shorthand an operator reaches for when they
  // want a reward off. Resolving the whole-entry case to ON leaves it paying
  // against an edit that reads, to whoever made it, like it worked — the same
  // hole `coerceEnabled` closes for the field, one level up.
  it('disables the reward when the whole entry is unreadable', async () => {
    for (const entry of [false, true, 'off', 'disabled', null, 0, 42, []]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: entry } });

      const config = await resolve();

      expect(config.enabled).toBe(false);
      expect(config.rejected).toContain('enabled');
      // The amounts still fall back rather than going to zero.
      expect(config.awardAmount).toBe(DEFAULTS.awardAmount);
      expect(config.cap).toBe(DEFAULTS.cap);
    }
  });

  it('leaves a reward on for an empty object, which says nothing either way', async () => {
    storedConfig({ rewards: { testReward: {} } });

    expect(await resolve()).toMatchObject({ enabled: true, rejected: [] });
  });

  // A non-strict object STRIPS an unknown key, so these would parse clean to `{}`
  // and resolve to enabled with nothing rejected and nothing logged — the
  // operator's edit reads as applied while the reward keeps paying.
  it('disables on an entry made entirely of keys it does not recognise', async () => {
    for (const entry of [{ enable: false }, { Enabled: false }, { disabled: true }]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: entry } });

      const config = await resolve();

      expect(config.enabled).toBe(false);
      expect(config.rejected).toEqual(Object.keys(entry));
    }
  });

  // A stray annotation beside a real field should not take a reward down.
  it('keeps the recognised fields and only reports the stray key', async () => {
    storedConfig({ rewards: { testReward: { cap: 8, note: 'for the launch' } } });

    expect(await resolve()).toMatchObject({ enabled: true, cap: 8, rejected: ['note'] });
  });

  // `usableOverride`'s doc promises a refused field does not re-enable a reward.
  // The unpinned converse: it must not disable one either.
  it('leaves a reward on when one field is refused and `enabled` is absent', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: -1, cap: 8 } } });

    expect(await resolve()).toMatchObject({ enabled: true, cap: 8 });
  });

  // `{"dailyBoost": {...}}` — the row someone hand-editing in Retool writes. A
  // non-strict envelope parses it as "no rewards key" and silently leaves
  // everything on.
  // 🔴 The whole-row version of "a stray key beside a real field keeps the real
  // field". A strict envelope discarded the entire map over one unrecognised
  // top-level key, and every reward an operator had turned off resumed paying —
  // the same situation as one level down, but with every reward as the blast
  // radius and money as the direction.
  // The assertion is about PAYMENT STATE, not about parsing. The failure this
  // guards is money: a reward an operator turned off resuming payment. "The row
  // parsed" would be green for a version of this that pays.
  it('leaves a disabled reward disabled when the row carries a stray top-level key', async () => {
    storedConfig({
      rewards: { testReward: { enabled: false, awardAmount: 4 } },
      note: 'for the launch',
    });

    const config = await resolve();

    expect(config.enabled).toBe(false);
    expect(config.awardAmount).toBe(4);
  });

  it('keeps every reward’s override, not just the first, past a stray key', async () => {
    storedConfig({
      rewards: { testReward: { enabled: false }, otherReward: { enabled: false } },
      owner: 'ops',
    });

    expect((await resolve()).enabled).toBe(false);
    expect((await resolveRewardConfig('otherReward', { ...DEFAULTS })).enabled).toBe(false);
  });

  it('warns about the stray rather than swallowing it', async () => {
    storedConfig({ rewards: { testReward: { enabled: false } }, note: 'x', owner: 'ops' });

    await resolve();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('unrecognised top-level keys'),
        strays: ['note', 'owner'],
      })
    );
  });

  // Asserts the WRITE did not happen, not merely that something threw. A bare
  // `rejects.toThrow()` passes here only because `beforeEach` nulls both row
  // mocks, so the malformed guard cannot fire and the schema is the only thing
  // left that can throw — a future edit seeding a bad row in shared setup would
  // keep this green for the wrong reason.
  it('still refuses to write a row with a stray top-level key', async () => {
    await expect(setRewardConfig({ rewards: {}, note: 'x' } as never, 1)).rejects.toThrow();

    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('warns and runs unconfigured on a row written without the `rewards` wrapper', async () => {
    storedConfig({ testReward: { enabled: false } });

    expect(await resolve()).toMatchObject({
      enabled: true,
      awardAmount: DEFAULTS.awardAmount,
    });
    expect(await getStoredRewardConfig()).toMatchObject({ malformed: true });
    // The WARNING is the whole difference a non-strict envelope makes: it would
    // resolve to exactly the same values, silently. Asserting only the values
    // tests nothing about the strictness.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reward-config',
        message: expect.stringContaining('no `rewards` wrapper'),
      })
    );
  });

  // A Retool text field produces the string, not the boolean. Falling back to the
  // compiled default here means falling back to ON, so the operator reads their
  // edit back, believes the reward is off, and it keeps paying.
  it('honours the string spellings of `enabled` an operator actually types', async () => {
    for (const enabled of ['false', 'False', ' FALSE ']) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { enabled } } });

      expect(await resolve()).toMatchObject({ enabled: false, rejected: [] });
    }

    for (const enabled of ['true', 'TRUE']) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { enabled } } });

      expect(await resolve()).toMatchObject({ enabled: true, rejected: [] });
    }
  });

  it('treats an unreadable `enabled` as off rather than leaving the reward paying', async () => {
    for (const enabled of [0, 1, 'no', 'off', null, {}]) {
      invalidateRewardConfigCache();
      storedConfig({ rewards: { testReward: { enabled } } });

      const config = await resolve();

      expect(config.enabled).toBe(false);
      expect(config.rejected).toContain('enabled');
    }
  });

  it('leaves a reward on when `enabled` is absent entirely', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });

    expect(await resolve()).toMatchObject({ enabled: true, rejected: [] });
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
  // its fallback for a full TTL.
  it('does not cache a failed read', async () => {
    findUnique.mockRejectedValueOnce(new Error('KeyValue unavailable'));

    const first = await resolve();
    expect(first.awardAmount).toBe(DEFAULTS.awardAmount);

    storedConfig({ rewards: { testReward: { awardAmount: 7 } } });
    expect((await resolve()).awardAmount).toBe(7);
  });

  // Falling back to the compiled defaults fails OPEN: the compiled default for
  // `enabled` is on, so a KeyValue blip would resume paying every reward an
  // operator had turned off, and `process` would then pay the backlog.
  it('keeps a disabled reward disabled when the read later fails', async () => {
    storedConfig({ rewards: { testReward: { enabled: false, awardAmount: 4 } } });
    expect((await resolve()).enabled).toBe(false);

    findUnique.mockRejectedValue(new Error('KeyValue unavailable'));
    vi.useFakeTimers();
    vi.advanceTimersByTime(120_000);

    expect(await resolve()).toMatchObject({ enabled: false, awardAmount: 4 });
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
  it('accepts and rejects the values the read path accepts and rejects', () => {
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

// The read path salvaging a bad row is what makes the write path's strictness
// load-bearing: a row that reaches disk must be one the read path honours in
// FULL, or an operator's edit half-applies and the surviving half is invisible.
// Asserting the schema alone would leave that binding to a comment — replacing
// `rewardConfigSchema.parse` with a passthrough has to turn something red.
describe('setRewardConfig', () => {
  const upsert = dbMock.dbWrite.keyValue.upsert;
  const MOD_ID = 99;

  it('refuses a key the read path would not recognise', async () => {
    await expect(
      setRewardConfig({ rewards: { testReward: { enable: false } } } as never, MOD_ID)
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a row written without the `rewards` wrapper', async () => {
    await expect(
      setRewardConfig({ testReward: { enabled: false } } as never, MOD_ID)
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  // A money-affecting moderator change with no attribution is not auditable.
  it('records who made the change and what it replaced', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });

    await setRewardConfig({ rewards: { testReward: { awardAmount: 7 } } }, MOD_ID);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reward-config',
        userId: MOD_ID,
        previous: JSON.stringify({ rewards: { testReward: { awardAmount: 4 } } }),
        value: JSON.stringify({ rewards: { testReward: { awardAmount: 7 } } }),
      })
    );
  });

  it('refuses the whole write when any field is out of bounds', async () => {
    await expect(
      setRewardConfig(
        { rewards: { testReward: { awardAmount: MAX_AWARD_AMOUNT + 1 } } } as never,
        MOD_ID
      )
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a cap the read path would refuse', async () => {
    await expect(
      setRewardConfig({ rewards: { testReward: { cap: MAX_CAP + 1 } } } as never, MOD_ID)
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  // The read path coerces `"false"` because Retool produces it; the write path
  // does not, because an editor sending a string means the editor is wrong.
  it('refuses a stringly-typed `enabled` that the read path would coerce', async () => {
    await expect(
      setRewardConfig({ rewards: { testReward: { enabled: 'false' } } } as never, MOD_ID)
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses one bad reward even when another in the same row is valid', async () => {
    await expect(
      setRewardConfig(
        {
          rewards: { good: { enabled: false }, bad: { awardAmount: -1 } },
        } as never,
        MOD_ID
      )
    ).rejects.toThrow();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes a valid row under the key the read path reads', async () => {
    const config = { rewards: { testReward: { enabled: false, awardAmount: 4, cap: 8 } } };

    await setRewardConfig(config, MOD_ID);

    expect(upsert).toHaveBeenCalledWith({
      where: { key: REWARD_CONFIG_KEY },
      create: { key: REWARD_CONFIG_KEY, value: config },
      update: { value: config },
    });
  });

  it('takes effect on the writing pod immediately rather than after the TTL', async () => {
    storedConfig({ rewards: { testReward: { awardAmount: 4 } } });
    expect((await resolve()).awardAmount).toBe(4);

    storedConfig({ rewards: { testReward: { awardAmount: 7 } } });
    await setRewardConfig({ rewards: { testReward: { awardAmount: 7 } } }, MOD_ID);

    expect((await resolve()).awardAmount).toBe(7);
  });

  // Invalidating clears the last-good fallback too, so without seeding it here a
  // read failure moments after the write re-enables the reward just disabled.
  it('leaves the reward it just disabled disabled when the next read fails', async () => {
    await setRewardConfig({ rewards: { testReward: { enabled: false, awardAmount: 4 } } }, MOD_ID);

    findUnique.mockRejectedValue(new Error('KeyValue unavailable'));

    expect(await resolve()).toMatchObject({ enabled: false, awardAmount: 4 });
  });
});

// A panel makes two moderators on the same screen ordinary rather than
// theoretical, and `set` replaces the whole row, so losing that race silently
// discards the other person's edit.
describe('setRewardConfig concurrency and malformed guards', () => {
  const upsert = dbMock.dbWrite.keyValue.upsert;
  const MOD_ID = 99;

  const withStored = async (value: unknown) => {
    storedConfig(value);
    return (await getStoredRewardConfig()).hash;
  };

  it('writes when the row is the one the caller read', async () => {
    const hash = await withStored({ rewards: { testReward: { awardAmount: 4 } } });

    await setRewardConfig({ rewards: { testReward: { awardAmount: 7 } } }, MOD_ID, {
      expectedHash: hash,
    });

    expect(upsert).toHaveBeenCalled();
  });

  it('refuses when the row moved under the caller', async () => {
    const stale = await withStored({ rewards: { testReward: { awardAmount: 4 } } });
    storedConfig({ rewards: { testReward: { awardAmount: 5 } } });

    await expect(
      setRewardConfig({ rewards: { testReward: { awardAmount: 7 } } }, MOD_ID, {
        expectedHash: stale,
      })
    ).rejects.toThrow(REWARD_CONFIG_CONFLICT.stale);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('distinguishes an absent row from an unreadable one', async () => {
    findUniqueWrite.mockResolvedValue(null);
    const absent = (await getStoredRewardConfig()).hash;
    const unreadable = await withStored({ rewards: 'all of them' });

    expect(absent).not.toBe(unreadable);
  });

  it('writes unconditionally when no hash is supplied', async () => {
    await withStored({ rewards: { testReward: { awardAmount: 4 } } });

    await setRewardConfig({ rewards: { testReward: { awardAmount: 7 } } }, MOD_ID);

    expect(upsert).toHaveBeenCalled();
  });

  // Overwriting a row nobody could render discards values the operator was never
  // shown, so it takes an explicit instruction rather than a normal save.
  it('refuses to save over a row that cannot be read', async () => {
    storedConfig({ rewards: { testReward: { enabled: 'false' } } });

    await expect(
      setRewardConfig({ rewards: { testReward: { enabled: false } } }, MOD_ID)
    ).rejects.toThrow(REWARD_CONFIG_CONFLICT.unreadable);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('saves over an unreadable row when forced', async () => {
    storedConfig({ rewards: { testReward: { enabled: 'false' } } });

    await setRewardConfig({ rewards: { testReward: { enabled: false } } }, MOD_ID, { force: true });

    expect(upsert).toHaveBeenCalled();
  });

  it('does not treat an absent row as unreadable', async () => {
    findUniqueWrite.mockResolvedValue(null);

    await setRewardConfig({ rewards: { testReward: { enabled: false } } }, MOD_ID);

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // A row PRESENT holding JSON `null`. The reader normalises `?? {}` before both
  // its checks, so it reports the row readable — clean form, Save enabled, and no
  // force button rendered. Gating this check on the raw value instead then
  // refuses every save that form can make, with the only control that could pass
  // `force` not on screen.
  it('agrees with the reader about a row that is present and null', async () => {
    storedConfig(null);

    const stored = await getStoredRewardConfig();
    expect(stored.malformed).toBe(false);

    await setRewardConfig({ rewards: { testReward: { enabled: false } } }, MOD_ID, {
      expectedHash: stored.hash,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // Both conditions hold for anyone who loaded before someone else broke the row.
  // Only one of the two messages names an action that works — reloading an
  // unreadable row returns the same unreadable row.
  it('reports an unreadable row as unreadable even when the hash is also stale', async () => {
    const stale = await withStored({ rewards: { testReward: { awardAmount: 4 } } });
    storedConfig({ rewards: { testReward: { enabled: 'false' } } });

    await expect(setRewardConfig({ rewards: {} }, MOD_ID, { expectedHash: stale })).rejects.toThrow(
      /cannot be read/
    );
  });

  // The concurrency guard decides whether another moderator's write survives, so
  // reading it off a replica passes on a row from before their save.
  it('reads the row it guards against from the primary', async () => {
    storedConfig({ rewards: {} });
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue({ value: { rewards: {} } });

    await getStoredRewardConfig();
    await setRewardConfig({ rewards: {} }, MOD_ID);

    expect(dbMock.dbWrite.keyValue.findUnique).toHaveBeenCalledTimes(2);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('getStoredRewardConfig', () => {
  it('returns the row as written, for an editor to render', async () => {
    const stored = { rewards: { testReward: { enabled: false, cap: 8 } } };
    storedConfig(stored);

    expect(await getStoredRewardConfig()).toMatchObject({ value: stored, malformed: false });
  });

  // `setRewardConfig` replaces the whole row, so an editor shown `{}` for a row it
  // could not parse would wipe every other reward's override on its first save —
  // and `enabled: "false"` from a Retool text field is exactly such a row.
  it('returns the RAW row when it would not survive a write, never an empty one', async () => {
    const stored = {
      rewards: { testReward: { enabled: 'false' }, otherReward: { awardAmount: 4 } },
    };
    storedConfig(stored);

    expect(await getStoredRewardConfig()).toMatchObject({ value: stored, malformed: true });
  });

  it('does not throw on a row that is not even an object', async () => {
    storedConfig('disabled');

    expect(await getStoredRewardConfig()).toMatchObject({ value: 'disabled', malformed: true });
  });

  // Uncached on purpose: an operator fixing a refused field needs what is in the
  // row, not what the read path salvaged, and not a minute-old copy of either.
  it('reads through on every call', async () => {
    storedConfig({ rewards: {} });

    await getStoredRewardConfig();
    await getStoredRewardConfig();

    expect(findUniqueWrite).toHaveBeenCalledTimes(2);
  });
});

// The panel builds the row and the grant path reads it, and nothing else sits
// between them. Driving the REAL builder into the REAL writer and out through the
// REAL resolver is the only place the two halves are checked against each other —
// each half's own tests pass with the row shape they happen to agree on.
describe('the round trip a moderator makes', () => {
  const panelRow = {
    type: 'testReward',
    capOverridable: true,
    defaults: { awardAmount: DEFAULTS.awardAmount, cap: DEFAULTS.cap },
    effective: { enabled: false, awardAmount: DEFAULTS.awardAmount, cap: DEFAULTS.cap },
  };

  it('switches a stored-off reward on, and the row still names it', async () => {
    storedConfig({ rewards: { testReward: { enabled: false } } });
    expect((await resolve()).enabled).toBe(false);

    const payload = buildRewardsPayload({
      rewards: [panelRow],
      overrides: { testReward: { enabled: false } },
      rows: { testReward: { enabled: true, awardAmount: '', cap: '' } },
    });

    // 🔴 This assertion, not the one below it, is what catches the defect.
    //
    // An absent entry resolves to enabled exactly as `{enabled:true}` does, so a
    // builder that DROPS the reward on the way in still ends this test with the
    // reward paying. That is precisely why the production bug was invisible: the
    // row emptied itself and everything kept working, with nothing left to show
    // an operator that they had decided anything.
    expect(payload.testReward).toEqual({ enabled: true });

    const written = await setRewardConfig({ rewards: payload }, 1);
    invalidateRewardConfigCache();
    storedConfig(written);

    expect(await resolve()).toMatchObject({
      enabled: true,
      awardAmount: DEFAULTS.awardAmount,
      cap: DEFAULTS.cap,
    });
  });

  it('turns it back off through the same path', async () => {
    storedConfig({ rewards: { testReward: { enabled: true } } });

    const payload = buildRewardsPayload({
      rewards: [{ ...panelRow, effective: { ...panelRow.effective, enabled: true } }],
      overrides: { testReward: { enabled: true } },
      rows: { testReward: { enabled: false, awardAmount: '', cap: '' } },
    });

    const written = await setRewardConfig({ rewards: payload }, 1);
    invalidateRewardConfigCache();
    storedConfig(written);

    expect((await resolve()).enabled).toBe(false);
  });
});

// The panel sends the hash it was last given as `expectedHash`. A writer that
// hands back the hash it LOADED describes a row that no longer exists, and the
// caller's next save is refused as somebody else's edit — a conflict dialog on a
// screen with one person in front of it.
describe('the hash a save hands back', () => {
  it('is accepted by the next save, while the pre-write hash is refused', async () => {
    storedConfig({ rewards: {} });
    const before = (await getStoredRewardConfig()).hash;

    const written = await setRewardConfig({ rewards: { testReward: { enabled: false } } }, 1);
    const after = storedViewOf(written).hash;
    // The row that is now on disk, for both attempts below.
    findUniqueWrite.mockResolvedValue({ value: written });

    // The control: without it this passes for a writer that returns a hash the
    // guard ignores entirely.
    await expect(setRewardConfig({ rewards: {} }, 1, { expectedHash: before })).rejects.toThrow(
      REWARD_CONFIG_CONFLICT.stale
    );

    await expect(
      setRewardConfig({ rewards: { testReward: { enabled: true } } }, 1, { expectedHash: after })
    ).resolves.toBeDefined();
  });
});

// The 60s per-pod memo is correct for the grant path — it runs on every reward
// grant — and wrong for a moderator's screen, which is why the operator views
// resolve a config they read themselves. Someone reading only the incident could
// reasonably conclude "the cache was the bug" and delete it; the first assertion
// here is what stops that, and the second is what would fail if the operator view
// ever picked it up again.
describe('the grant path keeps its cache while the operator view reads through', () => {
  it('serves the memoised answer to a grant while a fresh read already sees the change', async () => {
    storedConfig({ rewards: { testReward: { enabled: false } } });
    expect((await resolve()).enabled).toBe(false);

    storedConfig({ rewards: { testReward: { enabled: true } } });

    expect((await resolve()).enabled).toBe(false);

    const fresh = configFromStoredValue((await getStoredRewardConfig()).value);
    expect(resolveFromConfig(fresh, 'testReward', DEFAULTS).enabled).toBe(true);
  });
});
