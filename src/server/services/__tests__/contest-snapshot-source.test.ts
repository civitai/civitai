import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `snapshotSource()` stamps a contest snapshot as describing THROWAWAY DATA — in the stored
 * value and in the KeyValue key, where the docblock advertises it as a prefix-delete handle.
 *
 * It used to fire on `IS_PREVIEW`, which is a claim about environment identity, not about which
 * database the rows land in. A non-production deployment running against the PRODUCTION database
 * therefore stamped `preview` onto snapshots of REAL entries, badged them as disposable in the
 * moderator UI, and filed them under the deletable prefix. These cases pin the corrected matrix.
 *
 * Every expected key/marker below is a hand-written literal. `takenAt` is a fixed string rather
 * than a clock read, so the composed key is fully literal too.
 */

// Module-load scaffold: the service reaches Prisma, redis and ClickHouse at import time. None of
// them are on `snapshotSource`/`snapshotKey`'s path — both are pure functions of the environment
// and their arguments — so they only need to exist.
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: vi.fn(), keyValue: { findUnique: vi.fn() } },
  dbWrite: { $queryRaw: vi.fn(), keyValue: { create: vi.fn() } },
}));
vi.mock('~/server/db/db-helpers', () => ({ dbKV: { get: vi.fn(), set: vi.fn() } }));
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, redis: { packed: { get: vi.fn(), set: vi.fn() }, del: vi.fn() } };
});

const COLLECTION_ID = 4242;
const TAKEN_AT = '2026-08-05T11:22:33.444Z';

describe('contest snapshotSource — database-target gate', () => {
  const originalEnv = process.env;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.IS_PREVIEW;
    delete process.env.DATABASE_ENVIRONMENT;
    delete process.env.NEXT_PUBLIC_IS_PR_PREVIEW;
    delete process.env.NEXT_PUBLIC_PR_NUMBER;
    // The transitional cases trip the misconfiguration warning by design.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleError.mockRestore();
  });

  const source = async () => {
    const { snapshotSource } = await import('~/server/services/contest-score.service');
    return snapshotSource();
  };

  const key = async () => {
    const svc = await import('~/server/services/contest-score.service');
    return svc.snapshotKey(COLLECTION_ID, TAKEN_AT, svc.snapshotSource());
  };

  it('production (nothing set): no marker, unprefixed key', async () => {
    expect(await source()).toBe(null);
    expect(await key()).toBe('contestSnapshot:4242:2026-08-05T11:22:33.444Z');
  });

  it('🔴 non-production environment on the PRODUCTION database: no marker', async () => {
    // The bug this change exists to fix. Before it, this returned 'preview' and filed the row
    // under the deletable prefix.
    process.env.IS_PREVIEW = 'true';
    process.env.DATABASE_ENVIRONMENT = 'production';

    expect(await source()).toBe(null);
    expect(await key()).toBe('contestSnapshot:4242:2026-08-05T11:22:33.444Z');
  });

  it('non-production environment on a NON-PRODUCTION database: marked', async () => {
    process.env.IS_PREVIEW = 'true';
    process.env.DATABASE_ENVIRONMENT = 'non-production';

    expect(await source()).toBe('preview');
    expect(await key()).toBe('contestSnapshot:4242:preview:2026-08-05T11:22:33.444Z');
  });

  it('non-production database with a change number: marked with the number', async () => {
    process.env.IS_PREVIEW = 'true';
    process.env.DATABASE_ENVIRONMENT = 'non-production';
    process.env.NEXT_PUBLIC_PR_NUMBER = '3712';

    expect(await source()).toBe('preview-3712');
    expect(await key()).toBe('contestSnapshot:4242:preview-3712:2026-08-05T11:22:33.444Z');
  });

  it('🔴 transitional — IS_PREVIEW=true with DATABASE_ENVIRONMENT unset: marked', async () => {
    // Today's behaviour, preserved until the configuration half lands.
    process.env.IS_PREVIEW = 'true';

    expect(await source()).toBe('preview');
    expect(await key()).toBe('contestSnapshot:4242:preview:2026-08-05T11:22:33.444Z');
  });

  it('🔴 transitional — the ephemeral-deployment flag alone, variable unset: marked', async () => {
    // The second legacy spelling. It must keep working while the variable is unconfigured.
    process.env.NEXT_PUBLIC_IS_PR_PREVIEW = 'true';
    process.env.NEXT_PUBLIC_PR_NUMBER = '3712';

    expect(await source()).toBe('preview-3712');
    expect(await key()).toBe('contestSnapshot:4242:preview-3712:2026-08-05T11:22:33.444Z');
  });

  it('the configured variable overrides the legacy ephemeral-deployment flag', async () => {
    // Once set, DATABASE_ENVIRONMENT is the sole authority — an ephemeral deployment pointed at
    // the production database must not mark its rows.
    process.env.NEXT_PUBLIC_IS_PR_PREVIEW = 'true';
    process.env.NEXT_PUBLIC_PR_NUMBER = '3712';
    process.env.DATABASE_ENVIRONMENT = 'production';

    expect(await source()).toBe(null);
    expect(await key()).toBe('contestSnapshot:4242:2026-08-05T11:22:33.444Z');
  });

  it('non-production database without any environment-identity flag: marked', async () => {
    process.env.DATABASE_ENVIRONMENT = 'non-production';

    expect(await source()).toBe('preview');
    expect(await key()).toBe('contestSnapshot:4242:preview:2026-08-05T11:22:33.444Z');
  });

  it('a change number alone does not mark a production-database snapshot', async () => {
    // The number is a label, never the trigger.
    process.env.NEXT_PUBLIC_PR_NUMBER = '3712';

    expect(await source()).toBe(null);
    expect(await key()).toBe('contestSnapshot:4242:2026-08-05T11:22:33.444Z');
  });

  it('a marked key round-trips through the reader that authorises snapshot fetches', async () => {
    // The key is parsed back on read; a marker that the parser cannot recover would make the
    // row unfetchable. Pinned as a literal on both sides.
    process.env.DATABASE_ENVIRONMENT = 'non-production';
    const { listContestSnapshots } = await import('~/server/services/contest-score.service');
    const { dbRead } = await import('~/server/db/client');

    const marked = await key();
    (dbRead.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: marked, partial: false },
    ]);

    expect(await listContestSnapshots({ collectionId: COLLECTION_ID })).toEqual([
      {
        key: 'contestSnapshot:4242:preview:2026-08-05T11:22:33.444Z',
        source: 'preview',
        takenAt: '2026-08-05T11:22:33.444Z',
        partial: false,
      },
    ]);
  });
});
