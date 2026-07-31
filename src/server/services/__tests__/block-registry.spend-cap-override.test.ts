import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `BlockRegistry.getAppSpendCapOverride` / `setAppSpendCapOverride` — the
 * per-app generation-cap override WRITE path (mod-gated at the router; this
 * suite pins the data-integrity rules the service enforces regardless of
 * caller).
 *
 * What must hold:
 *   - It is a PATCH, not a full overwrite: an omitted field is untouched, an
 *     explicit null clears.
 *   - What is STORED is exactly what the READER will honour — the write goes
 *     through the same normalisation the resolver applies, so a stored value can
 *     never be silently reinterpreted or ignored at enforcement time.
 *   - The resolver's cache is invalidated, or the moderator's change appears to
 *     do nothing for a full TTL (the classic "I set it and it didn't work").
 *   - The response reports the EFFECTIVE ceilings so an operator can confirm the
 *     result without re-deriving the tier table by hand.
 *
 * No DB in unit tests: dbRead/dbWrite are mocked and the write `data` is
 * captured so the SHAPE is asserted.
 */

const { mockDb, mockInvalidate } = vi.hoisted(() => ({
  mockDb: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    blockUserSubscription: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
  mockInvalidate: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  },
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: {
    BLOCKS: {
      REGISTRY: 'packed:caches:block-registry',
      TOKEN_RATE_LIMIT: 'rl',
      REVOKED_INSTANCE: 'rev',
    },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));
vi.mock('~/server/services/blocks/app-cap-limits.service', async () => {
  // Keep the REAL normalisation (it is the contract under test); only the cache
  // side-effect is observed.
  const actual = await vi.importActual<
    typeof import('~/server/services/blocks/app-cap-limits.service')
  >('~/server/services/blocks/app-cap-limits.service');
  return {
    ...actual,
    invalidateAppCapLimits: (...a: unknown[]) => mockInvalidate(...a),
  };
});

import { BlockRegistry } from '../block-registry.service';
import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  APP_TIER_CAP_LIMITS,
  STRICTEST_APP_CAP_LIMITS,
} from '~/server/services/blocks/app-cap-limits.constants';

const APP = 'apb_1';

function updateData(): Record<string, unknown> {
  const call = mockDb.appBlock.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }];
  return call[0].data;
}

beforeEach(() => {
  mockDb.appBlock.findUnique.mockReset();
  mockDb.appBlock.update.mockReset();
  mockInvalidate.mockReset();
  mockDb.appBlock.findUnique.mockResolvedValue({ id: APP });
  mockDb.appBlock.update.mockResolvedValue({
    id: APP,
    trustTier: 'verified',
    spendCapBuzzPerDay: null,
    spendVelocityMaxGens: null,
  });
});

describe('getAppSpendCapOverride', () => {
  it('returns the tier, the raw override and the RESOLVED effective ceilings', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      trustTier: 'verified',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 1_500,
    });
    await expect(BlockRegistry.getAppSpendCapOverride(APP)).resolves.toEqual({
      appBlockId: APP,
      trustTier: 'verified',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 1_500,
      // daily falls back to the tier; velocity is the override.
      effective: { dailyBuzz: APP_TIER_CAP_LIMITS.verified.dailyBuzz, velocityMaxGens: 1_500 },
    });
  });

  it('surfaces the STRICTEST ceilings for an app on an unrecognised tier', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      trustTier: 'platinum',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    const config = await BlockRegistry.getAppSpendCapOverride(APP);
    expect(config?.effective).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('returns null for a missing app (the router turns that into NOT_FOUND)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(BlockRegistry.getAppSpendCapOverride('nope')).resolves.toBeNull();
  });
});

describe('setAppSpendCapOverride', () => {
  it('throws NOT_FOUND for a missing app and NEVER writes', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      BlockRegistry.setAppSpendCapOverride({ appBlockId: 'nope', spendCapBuzzPerDay: 5 })
    ).rejects.toBeTruthy();
    expect(mockDb.appBlock.update).not.toHaveBeenCalled();
  });

  it('is a PATCH — an OMITTED field is left out of the write entirely', async () => {
    await BlockRegistry.setAppSpendCapOverride({ appBlockId: APP, spendVelocityMaxGens: 900 });
    expect(updateData()).toEqual({ spendVelocityMaxGens: 900 });
    expect(updateData()).not.toHaveProperty('spendCapBuzzPerDay');
  });

  it('an explicit NULL clears the override (falls back to the tier)', async () => {
    await BlockRegistry.setAppSpendCapOverride({
      appBlockId: APP,
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    expect(updateData()).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });

  it('CLAMPS an over-bound value to the hard maximum before storing', async () => {
    await BlockRegistry.setAppSpendCapOverride({
      appBlockId: APP,
      spendCapBuzzPerDay: 9e15,
      spendVelocityMaxGens: 9e15,
    });
    expect(updateData()).toEqual({
      spendCapBuzzPerDay: APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
      spendVelocityMaxGens: APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
    });
  });

  it('stores NULL (not the raw value) for anything the READER would ignore', async () => {
    // Belt behind the zod `.min(1)`: the stored state and the ENFORCED state can
    // never disagree — a value that would be ignored at read time is not stored.
    await BlockRegistry.setAppSpendCapOverride({
      appBlockId: APP,
      spendCapBuzzPerDay: 0 as number,
      spendVelocityMaxGens: -3 as number,
    });
    expect(updateData()).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });

  it('INVALIDATES the resolver cache so the change is not invisible for a full TTL', async () => {
    await BlockRegistry.setAppSpendCapOverride({ appBlockId: APP, spendVelocityMaxGens: 42 });
    expect(mockInvalidate).toHaveBeenCalledWith(APP);
  });

  it('returns the newly EFFECTIVE ceilings, not just the stored columns', async () => {
    mockDb.appBlock.update.mockResolvedValue({
      id: APP,
      trustTier: 'unverified',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 42,
    });
    const result = await BlockRegistry.setAppSpendCapOverride({
      appBlockId: APP,
      spendVelocityMaxGens: 42,
    });
    expect(result).toEqual({
      appBlockId: APP,
      trustTier: 'unverified',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 42,
      effective: {
        dailyBuzz: APP_TIER_CAP_LIMITS.unverified.dailyBuzz,
        velocityMaxGens: 42,
      },
    });
  });

  it('writes ONLY the two cap columns — it is not a general app-row editor', async () => {
    await BlockRegistry.setAppSpendCapOverride({
      appBlockId: APP,
      spendCapBuzzPerDay: 100,
      spendVelocityMaxGens: 10,
    });
    expect(Object.keys(updateData()).sort()).toEqual([
      'spendCapBuzzPerDay',
      'spendVelocityMaxGens',
    ]);
  });
});
