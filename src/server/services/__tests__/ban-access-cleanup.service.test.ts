import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { BanCleanupDeps } from '../ban-access-cleanup.service';

// Run authorizations are revoked over real SQL.
const { pgRef } = vi.hoisted(() => ({ pgRef: { current: null as PGlite | null } }));
vi.mock('~/server/db/kyselyDb', async () => {
  const { pgliteKysely } = await import('~/__tests__/pglite-kysely');
  return { kyselyWrite: pgliteKysely(() => pgRef.current!) };
});

const { disableOauthForBannedUser, revokeRunnerAuthorizationsForBannedUser } = await import(
  '../ban-access-cleanup.service'
);

const USER = 4242;
const ASSISTANT = `appassist-${USER}`;
const DEV = `appdev-${USER}-pose-board`;
const THIRD_PARTY = 'b1e0c0de-0000-4000-8000-000000000001';
// Owned by the banned user but naming another user's id: not self-only.
const LOOKALIKE_DEV = `appdev-${USER}0-pose-board`;

// The boundaries the leg calls (token expiry, the orchestrator's auth cache, the moderator alert
// channel, the ban mark), passed in; `order` records the sequence across them and the DB writes.
let order: string[];
let deps: BanCleanupDeps & {
  expireClientTokens: ReturnType<typeof vi.fn>;
  revokeCivitaiUserTokens: ReturnType<typeof vi.fn>;
  notifyModAlert: ReturnType<typeof vi.fn>;
  markBanDisabledClients: ReturnType<typeof vi.fn>;
};

const owned = (rows: { id: string; accessMode?: string; name?: string }[]) =>
  dbMock.dbWrite.oauthClient.findMany.mockResolvedValue(
    rows.map((r) => ({ name: 'An app', accessMode: 'open', ...r })) as never
  );

beforeEach(async () => {
  pgRef.current = await PGlite.create();
  await pgRef.current.exec(`
    CREATE TABLE runner_run_authorizations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, runner_client_id TEXT NOT NULL,
      revoked_at TIMESTAMPTZ, revoked_reason TEXT
    );
  `);
  order = [];
  deps = {
    expireClientTokens: vi.fn(async (id: string) => void order.push(`expire:${id}`)),
    revokeCivitaiUserTokens: vi.fn(async () => true),
    notifyModAlert: vi.fn(async () => 'delivered' as const),
    markBanDisabledClients: vi.fn(
      async (cs: { id: string; priorMode: string }[]) =>
        void order.push(`mark:${cs.map((c) => `${c.id}=${c.priorMode}`)}`)
    ),
    revokeRunnerAuthorizations: revokeRunnerAuthorizationsForBannedUser,
  };
  owned([{ id: ASSISTANT }, { id: DEV }, { id: THIRD_PARTY, name: 'Prompt Pal' }]);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([{ userId: USER }, { userId: 99 }] as never);
  dbMock.dbWrite.oauthClient.updateMany.mockReset();
  dbMock.dbWrite.oauthClient.updateMany.mockImplementation((async () => {
    order.push('disable');
    return { count: 2 };
  }) as never);
  dbMock.dbWrite.oauthConsent.deleteMany.mockReset();
  dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 3 } as never);
});

afterEach(async () => {
  await pgRef.current?.close();
  pgRef.current = null;
});

describe('disableOauthForBannedUser', () => {
  it("🔴 revokes every run authorization the user gave any runner, and no one else's", async () => {
    await pgRef.current!.exec(`
      INSERT INTO runner_run_authorizations (id, user_id, runner_client_id) VALUES
        ('a', ${USER}, 'rcl_1'), ('b', ${USER}, 'rcl_2'), ('other', 99, 'rcl_1');
    `);
    await disableOauthForBannedUser(USER, deps);
    const { rows } = await pgRef.current!.query<{ id: string; reason: string | null }>(
      `SELECT id, revoked_reason AS reason FROM runner_run_authorizations ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 'a', reason: 'banned' },
      { id: 'b', reason: 'banned' },
      { id: 'other', reason: null },
    ]);
  });

  it('🔴 still deletes the consents when the authorization revoke fails', async () => {
    await pgRef.current!.exec(`DROP TABLE runner_run_authorizations`);
    const result = await disableOauthForBannedUser(USER, deps);
    expect(result.consents).toBe(3);
  });

  it('🔴 disables ONLY the self-only clients (App Assistant, dev tunnel), marking them once disabled', async () => {
    const result = await disableOauthForBannedUser(USER, deps);

    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ASSISTANT, DEV] } },
      data: { accessMode: 'disabled' },
    });
    // The ban mark goes on only after the disable landed, so a re-enable can tell it from a staff
    // disable and never re-opens a client the ban did not actually disable.
    expect(order).toEqual([
      'disable',
      `mark:${ASSISTANT}=open,${DEV}=open`,
      `expire:${ASSISTANT}`,
      `expire:${DEV}`,
    ]);
    expect(result).toMatchObject({ disabled: [ASSISTANT, DEV], flagged: [THIRD_PARTY] });
  });

  it('🔴 a third-party app the user owns is NOT disabled and its users keep their tokens; a moderator is told', async () => {
    owned([{ id: THIRD_PARTY, name: 'Prompt Pal' }, { id: LOOKALIKE_DEV }]);
    const result = await disableOauthForBannedUser(USER, deps);

    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(deps.markBanDisabledClients).not.toHaveBeenCalled();
    expect(deps.expireClientTokens).not.toHaveBeenCalled();
    expect(deps.revokeCivitaiUserTokens).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      disabled: [],
      flagged: [THIRD_PARTY, LOOKALIKE_DEV],
      flagDelivery: 'delivered',
    });
    expect(deps.notifyModAlert).toHaveBeenCalledTimes(1);
    // The app names are user-written.
    expect(deps.notifyModAlert.mock.calls[0][2]).toEqual({ noMentions: true });
  });

  it('🔴 the mark keeps each client’s mode from before the ban (testers stays testers on re-open)', async () => {
    owned([{ id: DEV, accessMode: 'testers' }]);
    await disableOauthForBannedUser(USER, deps);
    expect(deps.markBanDisabledClients).toHaveBeenCalledWith([{ id: DEV, priorMode: 'testers' }]);
  });

  it('🔴 a disable that fails leaves no ban mark (so no later enable can re-open the client)', async () => {
    dbMock.dbWrite.oauthClient.updateMany.mockRejectedValue(new Error('db down'));
    await disableOauthForBannedUser(USER, deps);
    expect(deps.markBanDisabledClients).not.toHaveBeenCalled();
  });

  it('🔴 revokes, at the orchestrator, every user who held a token under a disabled client', async () => {
    await disableOauthForBannedUser(USER, deps);
    expect(
      deps.revokeCivitaiUserTokens.mock.calls.map(([a]) => (a as { userId: number }).userId)
    ).toEqual([USER, 99]);
  });

  it('🔴 deletes the consents the user gave even when token expiry fails', async () => {
    deps.expireClientTokens.mockRejectedValue(new Error('db down'));
    const result = await disableOauthForBannedUser(USER, deps);
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledTimes(1);
    expect(result.consents).toBe(3);
  });

  it('🔴 an already-disabled self-only client (staff) is neither marked nor written again', async () => {
    owned([{ id: ASSISTANT, accessMode: 'disabled' }]);
    const result = await disableOauthForBannedUser(USER, deps);
    expect(deps.markBanDisabledClients).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(deps.notifyModAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ disabled: [], flagged: [], flagDelivery: null });
  });
});
