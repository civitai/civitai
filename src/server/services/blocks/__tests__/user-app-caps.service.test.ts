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
 */

const TIERS = ['free', 'founder', 'bronze', 'silver', 'gold'] as const;

const TODAY = {
  buzzPerDay: 50_000,
  planBuzzPerDay: 50_000,
  optInBuzzPerDay: 50_000,
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

/** The per-tier table recorded on the task: every number distinct across tiers and caps. */
const TIERED = {
  'apps.buzz-daily': {
    byTier: {
      bronze: { limit: 75_000 },
      silver: { limit: 100_000 },
      gold: { limit: 200_000 },
    },
  },
  'apps.storage-bytes': {
    byTier: {
      bronze: { limit: 4 * 1024 * 1024 },
      silver: { limit: 8 * 1024 * 1024 },
      gold: { limit: 16 * 1024 * 1024 },
    },
  },
  'apps.storage-docs': {
    byTier: { bronze: { limit: 2_000 }, silver: { limit: 5_000 }, gold: { limit: 10_000 } },
  },
};

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

describe('today: every tier gets the pre-tier constants', () => {
  it.each([...TIERS, null, 'unknown-tier'])('tier %s', async (tier) => {
    expect(await resolveUserAppCaps(7, deps({ tier }))).toEqual(TODAY);
  });

  // INVARIANT GUARD: ties the literals above to the constants enforcement read before this
  // change, so "unchanged for every tier" is a claim about the old enforced numbers too.
  it('the literals are the constants the cap and the doc store enforced before', () => {
    expect(TODAY.buzzPerDay).toBe(BLOCK_BUZZ_CAP_PER_DAY);
    expect(TODAY.docBytes).toBe(DEFAULT_DOC_STORE_LIMITS.userBytes);
    expect(TODAY.docCount).toBe(DEFAULT_DOC_STORE_LIMITS.userDocs);
  });

  it('with nothing to opt in to, neither the flag nor the opt-in record is read', async () => {
    const d = deps({ tier: 'gold' });
    await resolveUserAppCaps(7, d);
    expect(d.isOptInEnabled).not.toHaveBeenCalled();
    expect(d.readOptIn).not.toHaveBeenCalled();
  });
});

describe('per-tier caps from the usage-limits row', () => {
  const tiered = () => configFrom(TIERED);
  it.each([
    ['free', 50_000, 2_097_152, 1_000],
    ['founder', 50_000, 2_097_152, 1_000],
    ['bronze', 75_000, 4_194_304, 2_000],
    ['silver', 100_000, 8_388_608, 5_000],
    ['gold', 200_000, 16_777_216, 10_000],
  ])('%s', async (tier, buzz, bytes, docs) => {
    const caps = await resolveUserAppCaps(7, deps({ tier, getConfig: async () => tiered() }));
    expect(caps).toEqual({
      buzzPerDay: buzz,
      planBuzzPerDay: buzz,
      optInBuzzPerDay: buzz,
      optedIn: false,
      docBytes: bytes,
      docCount: docs,
    });
  });

  it('a failed session read serves the strictest tier, not the code default', async () => {
    const strict = configFrom({
      'apps.buzz-daily': { base: 60_000, byTier: { bronze: { limit: 40_000 } } },
      'apps.storage-docs': { base: 900, byTier: { gold: { limit: 300 } } },
    });
    const caps = await resolveUserAppCaps(
      7,
      deps({
        getConfig: async () => strict,
        getSessionUser: async () => {
          throw new Error('hub down');
        },
      })
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

  it('no session for the user serves the strictest tier too', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        getConfig: async () =>
          configFrom({
            'apps.buzz-daily': { base: 70_000, byTier: { silver: { limit: 30_000 } } },
          }),
        getSessionUser: async () => null,
      })
    );
    expect(caps.buzzPerDay).toBe(30_000);
  });

  it('a failed config read serves the code defaults for the tier', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        tier: 'gold',
        getConfig: async () => {
          throw new Error('db down');
        },
      })
    );
    expect(caps).toEqual(TODAY);
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
});

describe('continue on your own Buzz (opt-in)', () => {
  const withCeiling = () =>
    configFrom({
      'apps.buzz-daily': { byTier: { gold: { limit: 200_000 } } },
      'apps.buzz-daily-opt-in': { base: 65_000 },
    });

  it('opted in with the flag on: the cap rises to the opt-in ceiling and no further', async () => {
    const d = deps({
      getConfig: async () => withCeiling(),
      isOptInEnabled: vi.fn(async () => true),
      readOptIn: vi.fn(async () => true),
    });
    expect(await resolveUserAppCaps(7, d)).toEqual({
      buzzPerDay: 65_000,
      planBuzzPerDay: 50_000,
      optInBuzzPerDay: 65_000,
      optedIn: true,
      docBytes: 2_097_152,
      docCount: 1_000,
    });
  });

  it('a recorded opt-in is ignored with the flag off, and not even read', async () => {
    const d = deps({
      getConfig: async () => withCeiling(),
      isOptInEnabled: vi.fn(async () => false),
      readOptIn: vi.fn(async () => true),
    });
    const caps = await resolveUserAppCaps(7, d);
    expect(caps.buzzPerDay).toBe(50_000);
    expect(caps.optedIn).toBe(false);
    expect(d.readOptIn).not.toHaveBeenCalled();
  });

  it('a failed opt-in read is "not opted in"', async () => {
    const caps = await resolveUserAppCaps(
      7,
      deps({
        getConfig: async () => withCeiling(),
        isOptInEnabled: async () => true,
        readOptIn: async () => {
          throw new Error('redis down');
        },
      })
    );
    expect(caps.buzzPerDay).toBe(50_000);
  });

  it('a plan above the opt-in ceiling has nothing to opt in to', async () => {
    const d = deps({
      tier: 'gold',
      getConfig: async () => withCeiling(),
      isOptInEnabled: vi.fn(async () => true),
      readOptIn: vi.fn(async () => true),
    });
    const caps = await resolveUserAppCaps(7, d);
    expect(caps).toMatchObject({
      buzzPerDay: 200_000,
      planBuzzPerDay: 200_000,
      optInBuzzPerDay: 200_000,
      optedIn: false,
    });
    expect(d.readOptIn).not.toHaveBeenCalled();
  });

  // The opt-in is the VIEWER's: it is read for the user whose caps are resolved and nobody else,
  // so an app owner's caps (and so what they can be charged against) never move with a viewer's.
  it("one user's opt-in never reaches another user's caps", async () => {
    const VIEWER = 101;
    const OWNER = 202;
    const readOptIn = vi.fn(async (id: number) => id === VIEWER);
    const d = deps({
      getConfig: async () => withCeiling(),
      isOptInEnabled: async () => true,
      readOptIn,
    });
    expect((await resolveUserAppCaps(VIEWER, d)).buzzPerDay).toBe(65_000);
    expect((await resolveUserAppCaps(OWNER, d)).buzzPerDay).toBe(50_000);
    expect(readOptIn.mock.calls).toEqual([[VIEWER], [OWNER]]);
  });
});
