import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Revoking an app's access withdraws the store items its platform listed under the user's name
 * (catalog sync). The withdraw itself is executed on real rows in
 * `src/server/services/blocks/__tests__/app-sub-listing-catalog-creator.behavior.test.ts`; this
 * pins that revoking an app runs it, for the right user and client, after the consent is gone,
 * and that a failure never blocks the revoke. It also revokes the user's recipe-run authorizations
 * for the client, which must succeed before the consent goes.
 */

const { withdrawMock, deleteSubjectMock, invalidateMock, pgRef } = vi.hoisted(() => ({
  withdrawMock: vi.fn(),
  deleteSubjectMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
  pgRef: { current: null as PGlite | null },
}));
// The recipe runner's run authorizations, revoked over real SQL.
vi.mock('~/server/db/kyselyDb', async () => {
  const { pgliteKysely } = await import('~/__tests__/pglite-kysely');
  return { kyselyWrite: pgliteKysely(() => pgRef.current!) };
});
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  withdrawCatalogSubListingsForRevokedConsent: withdrawMock,
}));
vi.mock('~/server/http/orchestrator/api-key-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeySpend>()),
  deleteAuthSubject: deleteSubjectMock,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: invalidateMock,
}));

const { oauthConsentRouter } = await import('~/server/routers/oauth-consent.router');
const { createCallerFactory } = await import('~/server/trpc');
const { revokeOauthConsentForBlock } = await import(
  '~/server/services/blocks/oauth-consent-sync.service'
);

const USER_ID = 5150;
const CLIENT_ID = 'client-platform';
const APP_BLOCK_ID = 'apb_platform';

const caller = createCallerFactory(oauthConsentRouter)({
  user: { id: USER_ID, bannedAt: null, muted: false },
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: {},
  track: {},
  ip: '127.0.0.1',
  cache: {},
  req: undefined,
  res: undefined,
} as never);

const authorization = (id: string, userId: number, clientId: string) =>
  pgRef.current!.query(
    `INSERT INTO runner_run_authorizations (id, user_id, runner_client_id) VALUES ($1, $2, $3)`,
    [id, userId, clientId]
  );
const authorizations = async () =>
  Object.fromEntries(
    (
      await pgRef.current!.query<{ id: string; revoked: boolean; reason: string | null }>(
        `SELECT id, revoked_at IS NOT NULL AS revoked, revoked_reason AS reason FROM runner_run_authorizations`
      )
    ).rows.map((r) => [r.id, { revoked: r.revoked, reason: r.reason }])
  );

beforeEach(async () => {
  pgRef.current = await PGlite.create();
  await pgRef.current.exec(`
    CREATE TABLE runner_run_authorizations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, runner_client_id TEXT NOT NULL,
      revoked_at TIMESTAMPTZ, revoked_reason TEXT
    );
  `);
  withdrawMock.mockReset();
  withdrawMock.mockResolvedValue(3);
  invalidateMock.mockClear();
  deleteSubjectMock.mockClear();
  dbMock.dbWrite.oauthConsent.findUnique.mockReset();
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ id: 9, userId: USER_ID });
  dbMock.dbWrite.oauthConsent.delete.mockReset();
  dbMock.dbWrite.oauthConsent.delete.mockResolvedValue({ id: 9 });
  dbMock.dbWrite.oauthConsent.deleteMany.mockReset();
  dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.apiKey.deleteMany.mockReset();
  dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 2 });
  dbMock.dbRead.appBlock.findUnique.mockReset();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ appId: CLIENT_ID });
});

afterEach(async () => {
  await pgRef.current?.close();
  pgRef.current = null;
});

describe('oauthConsent.revokeApp', () => {
  it("revokes the user's run authorizations for that client, and no one else's", async () => {
    await authorization('mine', USER_ID, CLIENT_ID);
    await authorization('other-client', USER_ID, 'other-runner');
    await authorization('other-user', USER_ID + 1, CLIENT_ID);
    await caller.revokeApp({ clientId: CLIENT_ID });
    expect(await authorizations()).toEqual({
      mine: { revoked: true, reason: 'disconnected' },
      'other-client': { revoked: false, reason: null },
      'other-user': { revoked: false, reason: null },
    });
  });

  it('marks the runner client revoked at the disconnect time, for longer than a runner token lives', async () => {
    redisMock.redis.set.mockClear();
    const before = Math.floor(Date.now() / 1000);
    await caller.revokeApp({ clientId: CLIENT_ID });
    const call = redisMock.redis.set.mock.calls.find(
      ([key]) => key === `blocks:runner-revoked:${USER_ID}:${CLIENT_ID}`
    );
    expect(call).toBeDefined();
    expect(Number(call![1])).toBeGreaterThanOrEqual(before);
    expect(call![2]).toEqual({ EX: 240 });
  });

  it('still revokes when the revocation marker cannot be written', async () => {
    redisMock.redis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).resolves.toMatchObject({
      success: true,
    });
    expect(dbMock.dbWrite.oauthConsent.delete).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when the revoke fails, so the user can retry', async () => {
    await pgRef.current!.exec(`DROP TABLE runner_run_authorizations`);
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).rejects.toThrow();
    expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthConsent.delete).not.toHaveBeenCalled();
  });

  it("withdraws the user's catalog items for that client, after deleting the consent", async () => {
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).resolves.toEqual({
      success: true,
      catalogItemsWithdrawn: 3,
    });
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(withdrawMock).toHaveBeenCalledWith({ userId: USER_ID, clientId: CLIENT_ID });
    expect(withdrawMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.oauthConsent.delete.mock.invocationCallOrder[0]
    );
  });

  it('expires the revoked tokens in the auth cache before withdrawing the items', async () => {
    await caller.revokeApp({ clientId: CLIENT_ID });
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      withdrawMock.mock.invocationCallOrder[0]
    );
  });

  it('still revokes when the withdraw fails, and reports it as null', async () => {
    withdrawMock.mockRejectedValueOnce(new Error('store down'));
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).resolves.toEqual({
      success: true,
      catalogItemsWithdrawn: null,
    });
    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.oauthConsent.delete).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('withdraws nothing when there is no consent to revoke', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValueOnce(null);
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});

describe('revokeOauthConsentForBlock (an app block permission narrowing)', () => {
  // Invariant guard: it deletes a consent MIRROR that the next token mint rebuilds from the
  // grant, so it is not a user disconnecting a platform and must not withdraw catalog items.
  it('does not withdraw catalog items', async () => {
    await revokeOauthConsentForBlock({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledTimes(1);
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});
