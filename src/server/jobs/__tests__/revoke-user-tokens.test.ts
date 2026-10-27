import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The job's SELECT and the stamp's UPDATE run for real against PGlite; only the key expiry and the
// orchestrator call are faked.
const { expireUserApiKeys, revokeCivitaiUserTokens } = vi.hoisted(() => ({
  expireUserApiKeys: vi.fn(),
  revokeCivitaiUserTokens: vi.fn(),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  expireUserApiKeys,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens,
}));

const { revokeRecentlyBannedUserTokens } = await import('~/server/jobs/revoke-user-tokens');

const db = { pg: null as unknown as PGlite };
type Meta = Record<string, unknown> | null;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY,
      "bannedAt" timestamp(3),
      "deletedAt" timestamp(3),
      meta jsonb
    );
  `);
});
afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.pg.exec(`SET TIME ZONE 'UTC'`);
  envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: 'system-token' });
  await db.pg.exec(`DELETE FROM "User"`);
  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  expireUserApiKeys.mockResolvedValue({ expired: 0, orchestratorConfirmed: false });
  revokeCivitaiUserTokens.mockResolvedValue(false);
});

/** `bannedHoursAgo` / `deletedHoursAgo` null for never. */
async function seed(
  id: number,
  bannedHoursAgo: number | null,
  deletedHoursAgo: number | null,
  meta: Meta
) {
  await db.pg.query(
    `INSERT INTO "User" (id, "bannedAt", "deletedAt", meta) VALUES (
      $1,
      (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $2::int),
      (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $3::int),
      $4::jsonb
    )`,
    [id, bannedHoursAgo, deletedHoursAgo, meta === null ? null : JSON.stringify(meta)]
  );
}
const metaOf = async (id: number) =>
  (await db.pg.query<{ meta: Meta }>(`SELECT meta FROM "User" WHERE id = $1`, [id])).rows[0].meta;
const confirmedLater = { tokenRevocation: { confirmedAt: '2026-01-01T00:00:00Z' } };

describe('revoke-user-tokens job', () => {
  it('works on accounts banned or deleted in the last 72h, by the later of the two', async () => {
    await seed(1, 1, null, null);
    await seed(2, 200, 1, null); // deleted recently, banned long ago
    await seed(3, 80, null, null);
    await seed(4, null, null, null);
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys.mock.calls.map(([id]) => id).sort()).toEqual([1, 2]);
  });

  it('stamps a confirmed account, keeping its other meta, whether meta was an object or NULL', async () => {
    await seed(1, 1, null, { banDetails: { reasonCode: 'Other' } });
    await seed(2, 1, null, null);
    expireUserApiKeys.mockResolvedValue({ expired: 1, orchestratorConfirmed: true });
    await revokeRecentlyBannedUserTokens();
    expect(await metaOf(1)).toEqual({
      banDetails: { reasonCode: 'Other' },
      tokenRevocation: { confirmedAt: expect.any(String) },
    });
    expect(await metaOf(2)).toEqual({ tokenRevocation: { confirmedAt: expect.any(String) } });
  });

  it('counts a deletion after an old ban from the deletion', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    await seed(1, 200, 1, confirmedLater);
    await seed(2, 200, 50, null);
    await seed(3, 200, 1, null);
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys.mock.calls.map(([id]) => id).sort()).toEqual([1, 2, 3]);
    const alerted = vi
      .mocked(logToAxiom)
      .mock.calls.filter(
        ([e]) => (e as { name?: string }).name === 'user-token-revocation-unconfirmed'
      )
      .map(([e]) => (e as { userId: number }).userId);
    expect(alerted).toEqual([2]);
    expect(await metaOf(2)).toEqual({ tokenRevocation: { alertedAt: expect.any(String) } });
  });

  it('does not depend on the database session time zone', async () => {
    await db.pg.exec(`SET TIME ZONE 'America/Denver'`);
    await seed(1, 1, null, null);
    await seed(2, 80, null, null);
    expireUserApiKeys.mockResolvedValue({ expired: 1, orchestratorConfirmed: true });
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys.mock.calls).toEqual([[1]]);
    expect(await metaOf(1)).toEqual({ tokenRevocation: { confirmedAt: expect.any(String) } });
  });

  it('counts confirmed and unconfirmed accounts apart', async () => {
    await seed(1, 2, null, confirmedLater);
    await seed(2, 3, null, null);
    await expect(revokeRecentlyBannedUserTokens()).resolves.toEqual({
      accounts: 2,
      unconfirmed: 1,
    });
  });

  it('re-expires a confirmed account for its first day only', async () => {
    await seed(1, 2, null, confirmedLater);
    await seed(2, 30, null, confirmedLater);
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys.mock.calls).toEqual([[1]]);
  });

  it('retries an unconfirmed account whatever its age, and alerts once at 48h', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    await seed(1, 49, null, null);
    await seed(2, 47, null, null);
    await expect(revokeRecentlyBannedUserTokens()).resolves.toEqual({
      accounts: 2,
      unconfirmed: 2,
    });
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys).toHaveBeenCalledTimes(4);
    // One attempt per account per run: the run does not wait out the inline retries.
    expect(revokeCivitaiUserTokens).not.toHaveBeenCalled();
    const alerts = vi
      .mocked(logToAxiom)
      .mock.calls.filter(
        ([e]) => (e as { name?: string }).name === 'user-token-revocation-unconfirmed'
      );
    expect(alerts.map(([e]) => (e as { userId: number }).userId)).toEqual([1]);
    expect(await metaOf(1)).toEqual({ tokenRevocation: { alertedAt: expect.any(String) } });
    expect(await metaOf(2)).toBeNull();
  });

  it('one failing account does not stop the others', async () => {
    await seed(1, 2, null, confirmedLater);
    await seed(2, 3, null, confirmedLater);
    expireUserApiKeys.mockRejectedValueOnce(new Error('primary unavailable'));
    await revokeRecentlyBannedUserTokens();
    expect(expireUserApiKeys).toHaveBeenCalledTimes(2);
  });

  it('does nothing without an orchestrator token to confirm with', async () => {
    envMock.set({ ORCHESTRATOR_ACCESS_TOKEN: undefined });
    await seed(1, 49, null, null);
    await expect(revokeRecentlyBannedUserTokens()).resolves.toMatchObject({ accounts: 0 });
    expect(expireUserApiKeys).not.toHaveBeenCalled();
    expect(await metaOf(1)).toBeNull();
  });
});

describe('revokeUserTokens', () => {
  it('leaves an account that is no longer banned or deleted alone', async () => {
    const { revokeUserTokens } = await import('~/server/services/user-token-revocation.service');
    await seed(1, null, null, null);
    await expect(revokeUserTokens(1, { retryDelaysMs: [] })).resolves.toBe(false);
    expect(expireUserApiKeys).not.toHaveBeenCalled();
  });
});

describe('the confirmation stamp', () => {
  it('is not written when a later ban replaced the one the revocation started on', async () => {
    const { revokeUserTokens } = await import('~/server/services/user-token-revocation.service');
    await seed(1, 1, null, null);
    expireUserApiKeys.mockImplementation(async () => {
      await db.pg.exec(`UPDATE "User" SET "bannedAt" = NOW() AT TIME ZONE 'UTC' WHERE id = 1`);
      return { expired: 1, orchestratorConfirmed: true };
    });
    await expect(revokeUserTokens(1, { retryDelaysMs: [] })).resolves.toBe(true);
    expect(await metaOf(1)).toBeNull();
  });
});
