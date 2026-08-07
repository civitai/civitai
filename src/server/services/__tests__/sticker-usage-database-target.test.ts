import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';

/**
 * `recordStickerUsage` withholds usage-history rows when the deployment's ids come from a
 * throwaway database. The condition used to be `isPreview`, which is a claim about ENVIRONMENT
 * IDENTITY and not about which database is behind it — so a non-production deployment running
 * against the PRODUCTION database dropped real usage history while still charging for the
 * placements. These cases pin the corrected matrix.
 *
 * Expectations are literal (`toHaveBeenCalledTimes(0 | 1)` plus a hand-written row array), and
 * the environment is driven through `process.env` rather than through the module under test.
 *
 * `isProd` is forced true because every deployment in the matrix — production and non-production
 * alike — runs NODE_ENV=production; that is exactly why `isProd` alone was never sufficient. The
 * `!isProd` half of the guard gets its own case below.
 */

const isProdRef = vi.hoisted(() => ({ value: true }));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  get isProd() {
    return isProdRef.value;
  },
}));

// Module-load scaffold: `sticker.service` reaches Prisma clients, redis caches and the buzz
// service at import time. None of them are on `recordStickerUsage`'s path (it is a pure
// env-guard + array build + fire-and-forget call), so they only need to exist.
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: vi.fn() },
  dbWrite: { $queryRaw: vi.fn(), $transaction: vi.fn() },
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({ getBlockedPairIds: vi.fn() }));

const USER_ID = 77;
const COSMETIC_ID = 12;
const ENTITY_ID = 9001;

describe('recordStickerUsage — database-target gate', () => {
  const originalEnv = process.env;
  let stickerUsage: ReturnType<typeof vi.fn>;
  let track: { stickerUsage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    isProdRef.value = true;
    process.env = { ...originalEnv };
    delete process.env.IS_PREVIEW;
    delete process.env.DATABASE_ENVIRONMENT;
    stickerUsage = vi.fn().mockResolvedValue(undefined);
    track = { stickerUsage };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const record = async () => {
    const { recordStickerUsage } = await import('~/server/services/sticker.service');
    recordStickerUsage({
      track,
      userId: USER_ID,
      charged: new Map([[COSMETIC_ID, 2]]),
      entityType: 'comment',
      entityId: ENTITY_ID,
    });
  };

  it('production (neither variable set): emits', async () => {
    await record();

    // Positive control for the whole file: the emit path really is reachable here, so a `0`
    // in any case below is a decision and not a harness that is wired to nothing.
    expect(stickerUsage).toHaveBeenCalledTimes(1);
    expect(stickerUsage).toHaveBeenCalledWith([
      { userId: 77, cosmeticId: 12, entityType: 'comment', entityId: 9001 },
      { userId: 77, cosmeticId: 12, entityType: 'comment', entityId: 9001 },
    ]);
  });

  it('🔴 non-production environment on the PRODUCTION database: emits', async () => {
    // The bug this change exists to fix. Before it, this dropped the rows.
    process.env.IS_PREVIEW = 'true';
    process.env.DATABASE_ENVIRONMENT = 'production';

    await record();

    expect(stickerUsage).toHaveBeenCalledTimes(1);
    expect(stickerUsage).toHaveBeenCalledWith([
      { userId: 77, cosmeticId: 12, entityType: 'comment', entityId: 9001 },
      { userId: 77, cosmeticId: 12, entityType: 'comment', entityId: 9001 },
    ]);
  });

  it('non-production environment on a NON-PRODUCTION database: withholds', async () => {
    process.env.IS_PREVIEW = 'true';
    process.env.DATABASE_ENVIRONMENT = 'non-production';

    await record();

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });

  it('🔴 transitional — IS_PREVIEW=true with DATABASE_ENVIRONMENT unset: withholds', async () => {
    // Today's behaviour, and it must not change before the configuration half lands. If this
    // flips, ephemeral deployments start writing scratch-database ids into the shared sink.
    process.env.IS_PREVIEW = 'true';

    await record();

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });

  it('non-production database without IS_PREVIEW: withholds', async () => {
    process.env.DATABASE_ENVIRONMENT = 'non-production';

    await record();

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });

  it('non-production NODE_ENV: withholds regardless of the database', async () => {
    // The `!isProd` half of the guard, exercised on an input the database test cannot reject —
    // so it is reached rather than shadowed.
    isProdRef.value = false;
    process.env.DATABASE_ENVIRONMENT = 'production';

    await record();

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });

  it('no charged placements: withholds even on production', async () => {
    // The privacy path (DMs are free, so `charged` is empty). Pinned so a rewrite of the
    // database gate cannot absorb it.
    const { recordStickerUsage } = await import('~/server/services/sticker.service');
    recordStickerUsage({
      track,
      userId: USER_ID,
      charged: new Map(),
      entityType: 'chat',
      entityId: ENTITY_ID,
    });

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });

  it('no tracker: withholds', async () => {
    const { recordStickerUsage } = await import('~/server/services/sticker.service');
    recordStickerUsage({
      userId: USER_ID,
      charged: new Map([[COSMETIC_ID, 2]]),
      entityType: 'comment',
      entityId: ENTITY_ID,
    });

    expect(stickerUsage).toHaveBeenCalledTimes(0);
  });
});
