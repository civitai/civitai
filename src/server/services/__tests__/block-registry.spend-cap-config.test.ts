import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `BlockRegistry.getAppSpendCapConfig` / `setAppSpendCapConfig` — the per-app
 * generation SPEND TIER + cap-override WRITE path (mod-gated at the router;
 * this suite pins the data-integrity rules the service enforces regardless of
 * caller).
 *
 * What must hold:
 *   - It writes `spendTier` and NEVER `trustTier`. Spend and browser-isolation
 *     are separate axes; promoting one must not move the other.
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

const { mockInvalidate } = vi.hoisted(() => ({ mockInvalidate: vi.fn() }));

// One local served both clients and the two entry points disagree: getAppSpendCapConfig reads
// `dbRead.appBlock.findUnique` (block-registry.service:3652), setAppSpendCapConfig uses
// `dbWrite` for its findUnique (:3702) and its update (:3720). The shared `beforeEach` therefore
// arms findUnique on BOTH nodes — see the comment there.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedis = redisMock.redis;

// `scanIterator` is consumed with `for await`; a vivified spy returns undefined, which throws
// rather than iterating.
mockRedis.scanIterator.mockImplementation(async function* () {});
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));
vi.mock('~/server/services/blocks/app-cap-limits.service', async () => {
  // Keep the REAL normalisation (it is the contract under test); only the cache
  // side-effect is observed.
  const actual = await vi.importActual<Record<string, unknown>>(
    '~/server/services/blocks/app-cap-limits.service'
  );
  return {
    ...actual,
    invalidateAppCapLimits: (...a: unknown[]) => mockInvalidate(...a),
  };
});

import { BlockRegistry } from '../block-registry.service';
import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  APP_SPEND_TIER_CAP_LIMITS,
  STRICTEST_APP_CAP_LIMITS,
} from '~/server/services/blocks/app-cap-limits.constants';

const APP = 'apb_1';

function updateData(): Record<string, unknown> {
  const call = mockDbWrite.appBlock.update.mock.calls.at(-1) as [{ data: Record<string, unknown> }];
  return call[0].data;
}

beforeEach(() => {
  // `appBlock.findUnique` is armed on BOTH clients because the two describe blocks below read it
  // through different ones — getAppSpendCapConfig on dbRead (block-registry.service:3652),
  // setAppSpendCapConfig on dbWrite (:3702). Arming only one would leave the other describe on
  // the canonical `null` default and take the NOT_FOUND branch throughout.
  mockDbRead.appBlock.findUnique.mockReset();
  mockDbWrite.appBlock.findUnique.mockReset();
  mockDbWrite.appBlock.update.mockReset();
  mockInvalidate.mockReset();
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: APP });
  mockDbWrite.appBlock.findUnique.mockResolvedValue({ id: APP });
  mockDbWrite.appBlock.update.mockResolvedValue({
    id: APP,
    spendTier: 'trusted',
    spendCapBuzzPerDay: null,
    spendVelocityMaxGens: null,
  });
});

describe('getAppSpendCapConfig', () => {
  it('returns the SPEND tier, the raw override and the RESOLVED effective ceilings', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({
      id: APP,
      spendTier: 'trusted',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 1_500,
    });
    await expect(BlockRegistry.getAppSpendCapConfig(APP)).resolves.toEqual({
      appBlockId: APP,
      spendTier: 'trusted',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 1_500,
      // daily falls back to the tier; velocity is the override.
      effective: { dailyBuzz: APP_SPEND_TIER_CAP_LIMITS.trusted.dailyBuzz, velocityMaxGens: 1_500 },
    });
  });

  it('surfaces the STRICTEST ceilings for an app on an unrecognised tier', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue({
      id: APP,
      spendTier: 'platinum',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    const config = await BlockRegistry.getAppSpendCapConfig(APP);
    expect(config?.effective).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('returns null for a missing app (the router turns that into NOT_FOUND)', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(BlockRegistry.getAppSpendCapConfig('nope')).resolves.toBeNull();
  });
});

describe('setAppSpendCapConfig', () => {
  it('throws NOT_FOUND for a missing app and NEVER writes', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      BlockRegistry.setAppSpendCapConfig({ appBlockId: 'nope', spendCapBuzzPerDay: 5 })
    ).rejects.toBeTruthy();
    expect(mockDbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('is a PATCH — an OMITTED field is left out of the write entirely', async () => {
    await BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendVelocityMaxGens: 900 });
    expect(updateData()).toEqual({ spendVelocityMaxGens: 900 });
    expect(updateData()).not.toHaveProperty('spendCapBuzzPerDay');
  });

  it('an explicit NULL clears the override (falls back to the tier)', async () => {
    await BlockRegistry.setAppSpendCapConfig({
      appBlockId: APP,
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    expect(updateData()).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });

  it('CLAMPS an over-bound value to the hard maximum before storing', async () => {
    await BlockRegistry.setAppSpendCapConfig({
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
    await BlockRegistry.setAppSpendCapConfig({
      appBlockId: APP,
      spendCapBuzzPerDay: 0 as number,
      spendVelocityMaxGens: -3 as number,
    });
    expect(updateData()).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });

  it('INVALIDATES the resolver cache so the change is not invisible for a full TTL', async () => {
    await BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendVelocityMaxGens: 42 });
    expect(mockInvalidate).toHaveBeenCalledWith(APP);
  });

  it('returns the newly EFFECTIVE ceilings, not just the stored columns', async () => {
    mockDbWrite.appBlock.update.mockResolvedValue({
      id: APP,
      spendTier: 'standard',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 42,
    });
    const result = await BlockRegistry.setAppSpendCapConfig({
      appBlockId: APP,
      spendVelocityMaxGens: 42,
    });
    expect(result).toEqual({
      appBlockId: APP,
      spendTier: 'standard',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: 42,
      effective: {
        dailyBuzz: APP_SPEND_TIER_CAP_LIMITS.standard.dailyBuzz,
        velocityMaxGens: 42,
      },
    });
  });

  it('writes ONLY the three spend columns — it is not a general app-row editor', async () => {
    await BlockRegistry.setAppSpendCapConfig({
      appBlockId: APP,
      spendTier: 'trusted',
      spendCapBuzzPerDay: 100,
      spendVelocityMaxGens: 10,
    });
    expect(Object.keys(updateData()).sort()).toEqual([
      'spendCapBuzzPerDay',
      'spendTier',
      'spendVelocityMaxGens',
    ]);
  });

  it('🔴 NEVER writes `trustTier` — promoting spend must not touch iframe privileges', async () => {
    // The decoupling, at the only write surface that exists. A spend promotion
    // must not hand the app `allow-same-origin` + `allow-scripts`, and it must
    // not silently re-tier it for rendering.
    await BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendTier: 'platform' });
    expect(updateData()).toEqual({ spendTier: 'platform' });
    expect(updateData()).not.toHaveProperty('trustTier');
    expect(updateData()).not.toHaveProperty('renderMode');
  });

  it('sets the SPEND TIER alone, leaving the overrides untouched', async () => {
    await BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendTier: 'trusted' });
    expect(updateData()).toEqual({ spendTier: 'trusted' });
    expect(updateData()).not.toHaveProperty('spendCapBuzzPerDay');
    expect(updateData()).not.toHaveProperty('spendVelocityMaxGens');
  });

  it('an OMITTED spendTier is left out of the write (a tier is not reset by an override edit)', async () => {
    await BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendCapBuzzPerDay: 1_000 });
    expect(updateData()).not.toHaveProperty('spendTier');
  });

  it('reports the effective ceilings for the NEW tier after a promotion', async () => {
    mockDbWrite.appBlock.update.mockResolvedValue({
      id: APP,
      spendTier: 'platform',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    });
    await expect(
      BlockRegistry.setAppSpendCapConfig({ appBlockId: APP, spendTier: 'platform' })
    ).resolves.toEqual({
      appBlockId: APP,
      spendTier: 'platform',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
      effective: APP_SPEND_TIER_CAP_LIMITS.platform,
    });
  });
});
