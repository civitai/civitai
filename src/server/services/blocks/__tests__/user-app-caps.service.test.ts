import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOC_STORE_LIMITS } from '~/server/services/apps/doc-store.types';
import {
  resolveUserAppCaps,
  type UserAppCapsDeps,
} from '~/server/services/blocks/user-app-caps.service';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';
import { buildUsageLimitConfig, type UsageLimitConfig } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';

/**
 * `resolveUserAppCaps` — the ONE source of a user's app caps — against literal expectations.
 * Dependencies are injected, so each case states the config, the session and the opt-in it runs
 * under. No expected value is read from the implementation or the registry.
 *
 * The code defaults are the per-tier table recorded on the task (11/10): Free 50,000 Buzz/day,
 * 2 MiB, 1,000 docs; Bronze 75,000 / 4 MiB / 2,000; Silver 100,000 / 8 MiB / 5,000; Gold
 * 200,000 / 16 MiB / 10,000. Founder (a tier the membership code also has) maps to Bronze. The
 * opt-in ceiling is twice the tier's daily cap.
 */

/** [tier, Buzz/day, bytes, docs, opt-in ceiling] — literals, never derived. */
const TABLE: [string, number, number, number, number][] = [
  ['free', 50_000, 2_097_152, 1_000, 100_000],
  ['founder', 75_000, 4_194_304, 2_000, 150_000],
  ['bronze', 75_000, 4_194_304, 2_000, 150_000],
  ['silver', 100_000, 8_388_608, 5_000, 200_000],
  ['gold', 200_000, 16_777_216, 10_000, 400_000],
];

const FREE = {
  buzzPerDay: 50_000,
  planBuzzPerDay: 50_000,
  optInBuzzPerDay: 100_000,
  optedIn: false,
  docBytes: 2_097_152,
  docCount: 1_000,
};

/** A config parsed from a `usage-limits` KeyValue row, the way production loads one. */
function configFrom(limits: Record<string, unknown>): UsageLimitConfig {
  const { config, fallbacks } = buildUsageLimitConfig({ version: 1, limits });
  expect(fallbacks).toEqual([]);
  return config;
}

function deps(over: Partial<UserAppCapsDeps> & { tier?: string | null } = {}) {
  const { tier = 'free', ...rest } = over;
  return {
    getConfig: async () => buildUsageLimitConfig(undefined).config,
    getSessionUser: async (id: number) => ({ id, tier } as unknown as SessionUser),
    isOptInEnabled: vi.fn(async () => false),
    readOptIn: vi.fn(async () => false),
    ...rest,
  };
}

describe('code defaults: the per-tier table', () => {
  it.each(TABLE)('%s', async (tier, buzz, bytes, docs, optIn) => {
    expect(await resolveUserAppCaps(7, deps({ tier }))).toEqual({
      buzzPerDay: buzz,
      planBuzzPerDay: buzz,
      optInBuzzPerDay: optIn,
      optedIn: false,
      docBytes: bytes,
      docCount: docs,
    });
  });

  it.each([null, 'unknown-tier'])('no tier or an unknown one (%s) reads as Free', async (tier) => {
    expect(await resolveUserAppCaps(7, deps({ tier }))).toEqual(FREE);
  });

  // INVARIANT GUARD: Free is exactly what every user was held to before tiers existed. Ties the
  // Free literals to the constants enforcement read before this change.
  it('Free is unchanged from the pre-tier constants', () => {
    expect(FREE.buzzPerDay).toBe(BLOCK_BUZZ_CAP_PER_DAY);
    expect(FREE.docBytes).toBe(DEFAULT_DOC_STORE_LIMITS.userBytes);
    expect(FREE.docCount).toBe(DEFAULT_DOC_STORE_LIMITS.userDocs);
  });
});

describe('overrides in the usage-limits row', () => {
  it('a tier value set in the row replaces the code default for that cap', async () => {
    const config = configFrom({ 'apps.buzz-daily': { byTier: { gold: { limit: 61_234 } } } });
    const caps = await resolveUserAppCaps(7, deps({ tier: 'gold', getConfig: async () => config }));
    // The opt-in ceiling follows the overridden cap: twice it.
    expect(caps).toMatchObject({ planBuzzPerDay: 61_234, optInBuzzPerDay: 122_468 });
  });

  it('a failed session read serves the strictest tier (Free), with no opt-in', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        getSessionUser: async () => {
          throw new Error('hub down');
        },
      })
    );
    expect(caps).toEqual({ ...FREE, optInBuzzPerDay: 50_000 });
  });

  it('the strictest is taken per cap across tiers, whichever tier holds it', async () => {
    const strict = configFrom({
      'apps.buzz-daily': { base: 60_000, byTier: { bronze: { limit: 40_000 } } },
      'apps.storage-docs': { base: 900, byTier: { gold: { limit: 300 } } },
    });
    const caps = await resolveUserAppCaps(
      7,
      deps({ getConfig: async () => strict, getSessionUser: async () => null })
    );
    expect(caps).toEqual({
      buzzPerDay: 40_000,
      planBuzzPerDay: 40_000,
      optInBuzzPerDay: 40_000,
      optedIn: false,
      docBytes: 2_097_152,
      docCount: 300,
    });
  });

  it('a failed config read serves the code defaults for the tier', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        tier: 'silver',
        getConfig: async () => {
          throw new Error('db down');
        },
      })
    );
    expect(caps).toMatchObject({ planBuzzPerDay: 100_000, docBytes: 8_388_608, docCount: 5_000 });
  });

  it('an override cannot disable an app cap: the row is refused and the default holds', () => {
    const { fallbacks } = buildUsageLimitConfig({
      version: 1,
      limits: { 'apps.buzz-daily': { disabled: true } },
    });
    expect(fallbacks).toEqual([
      { id: 'apps.buzz-daily', reason: 'only a product limit can be disabled' },
    ]);
  });

  // How an override expresses the opt-in ceiling: a `byTier` rule on `apps.buzz-daily-opt-in`.
  // `{ multiplier: m }` is m times that tier's daily cap; `{ limit: n }` is n Buzz. A tier the
  // row gives no rule keeps the default, twice its daily cap.
  it('the opt-in ceiling per tier: a multiple, a fixed figure, or the 2x default', async () => {
    const config = configFrom({
      'apps.buzz-daily-opt-in': {
        byTier: { gold: { multiplier: 3 }, silver: { limit: 123_456 } },
      },
    });
    const ceiling = async (tier: string) =>
      (await resolveUserAppCaps(7, deps({ tier, getConfig: async () => config }))).optInBuzzPerDay;
    expect(await ceiling('gold')).toBe(600_000);
    expect(await ceiling('silver')).toBe(123_456);
    expect(await ceiling('bronze')).toBe(150_000);
    expect(await ceiling('free')).toBe(100_000);
  });

  it('an opt-in figure below the daily cap gives nothing to opt in to', async () => {
    const config = configFrom({
      'apps.buzz-daily-opt-in': { byTier: { bronze: { limit: 10_000 } } },
    });
    const d = deps({
      tier: 'bronze',
      getConfig: async () => config,
      isOptInEnabled: vi.fn(async () => true),
      readOptIn: vi.fn(async () => true),
    });
    expect(await resolveUserAppCaps(7, d)).toMatchObject({
      buzzPerDay: 75_000,
      optInBuzzPerDay: 75_000,
      optedIn: false,
    });
    expect(d.readOptIn).not.toHaveBeenCalled();
  });
});

describe('continue on your own Buzz (opt-in)', () => {
  it.each([
    ['free', 100_000],
    ['gold', 400_000],
  ])('opted in with the flag on: a %s viewer may reach %d for the day', async (tier, cap) => {
    const d = deps({
      tier,
      isOptInEnabled: vi.fn(async () => true),
      readOptIn: vi.fn(async () => true),
    });
    expect(await resolveUserAppCaps(7, d)).toMatchObject({
      buzzPerDay: cap,
      optInBuzzPerDay: cap,
      optedIn: true,
    });
  });

  it('a recorded opt-in is ignored with the flag off, and not even read', async () => {
    const d = deps({
      isOptInEnabled: vi.fn(async () => false),
      readOptIn: vi.fn(async () => true),
    });
    const caps = await resolveUserAppCaps(7, d);
    expect(caps.buzzPerDay).toBe(50_000);
    expect(caps.optedIn).toBe(false);
    expect(d.readOptIn).not.toHaveBeenCalled();
  });

  it('flag on but no opt-in recorded: the plan cap', async () => {
    const d = deps({ tier: 'silver', isOptInEnabled: vi.fn(async () => true) });
    expect((await resolveUserAppCaps(7, d)).buzzPerDay).toBe(100_000);
  });

  it('a failed opt-in read is "not opted in"', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        isOptInEnabled: async () => true,
        readOptIn: async () => {
          throw new Error('redis down');
        },
      })
    );
    expect(caps.buzzPerDay).toBe(50_000);
  });

  // The opt-in is the VIEWER's: it is read for the user whose caps are resolved and nobody else,
  // so an app owner's caps (and so what they can be charged against) never move with a viewer's.
  it("one user's opt-in never reaches another user's caps", async () => {
    const VIEWER = 101;
    const OWNER = 202;
    const readOptIn = vi.fn(async (id: number) => id === VIEWER);
    const d = deps({ isOptInEnabled: async () => true, readOptIn });
    expect((await resolveUserAppCaps(VIEWER, d)).buzzPerDay).toBe(100_000);
    expect((await resolveUserAppCaps(OWNER, d)).buzzPerDay).toBe(50_000);
    expect(readOptIn.mock.calls).toEqual([[VIEWER], [OWNER]]);
  });
});
