import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  proposeMemorial,
  confirmMemorial,
  reverseMemorial,
  publicMemorial,
  memorialActorRefusal,
  metaWithoutMemorialSql,
  memorializedAmong,
  assertNotMemorialized,
  MemorializedAccountError,
} = await import('~/server/services/memorial.service');

// Redis, the signals service and the orchestrator: what confirming reaches outside the database.
const invalidateSession = vi.fn(async () => undefined);
const expireUserApiKeys = vi.fn(async () => ({ expired: 2, orchestratorConfirmed: true }));
const syncEventStanding = vi.fn(async () => undefined);
const bustUserCreator = vi.fn(async () => undefined);
const effects = {
  invalidateSession,
  expireUserApiKeys,
  bustUserCreator,
  syncEventStanding,
};
/** Confirms the proposal as a moderator who opened the panel now would see it. */
const confirm = async (actorId: number) => {
  const { proposedAt } = (await row()).meta.memorial as { proposedAt: string };
  return confirmMemorial({ userId: USER, actorId, proposedAt }, effects);
};
const reverse = () => reverseMemorial({ userId: USER }, effects);

const USER = 990400001;
const PROPOSER = 7;
const CONFIRMER = 8;
const TRIBUTE = { label: 'Tribute model', url: 'https://civitai.red/models/1/tribute' };

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`CREATE TABLE "User" (
    "id" INTEGER PRIMARY KEY, "username" TEXT, "flags" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB DEFAULT '{}', "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3)
  )`);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
  dbMock.dbRead.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
  invalidateSession.mockImplementation(async () => undefined);
  dbMock.dbWrite.user.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await pg.query('SELECT * FROM "User" WHERE id = $1', [where.id])).rows[0] ?? null) as never
  );
  await pg.exec('DELETE FROM "User"');
  await pg.query('INSERT INTO "User" (id, username) VALUES ($1, $2)', [USER, 'zavy']);
});

const row = async () =>
  (
    await pg.query<{ flags: number; meta: Record<string, unknown> }>(
      'SELECT flags, meta FROM "User" WHERE id = $1',
      [USER]
    )
  ).rows[0];

const propose = () =>
  proposeMemorial({ userId: USER, actorId: PROPOSER, basis: 'attestation', tributes: [TRIBUTE] });

describe('memorialization (docs/features/memorialized-profiles.md)', () => {
  it('changes nothing public until a second moderator confirms', async () => {
    await propose();
    const { flags, meta } = await row();
    expect(flags & UserFlag.Memorialized).toBe(0);
    expect(publicMemorial(meta)).toBeNull();
  });

  // The two-person rule: docs/features/memorialized-profiles.md.
  it('refuses a confirmation by the moderator who proposed it', async () => {
    await propose();
    await expect(confirm(PROPOSER)).rejects.toThrow(/different moderator/);
    expect((await row()).flags & UserFlag.Memorialized).toBe(0);
    expect(invalidateSession).not.toHaveBeenCalled();
    expect(expireUserApiKeys).not.toHaveBeenCalled();
    expect(bustUserCreator).not.toHaveBeenCalled();
  });

  it('on a second moderator, memorializes, signs the account out and expires its keys', async () => {
    await propose();
    await confirm(CONFIRMER);

    const { flags, meta } = await row();
    expect(flags & UserFlag.Memorialized).toBe(UserFlag.Memorialized);
    expect(flags & UserFlag.ExcludeFromEventPoints).toBe(UserFlag.ExcludeFromEventPoints);
    expect(publicMemorial(meta)).toEqual({ tributes: [TRIBUTE] });
    expect(invalidateSession).toHaveBeenCalledWith(USER, 'moderation');
    expect(expireUserApiKeys).toHaveBeenCalledWith(USER);
    expect(syncEventStanding).toHaveBeenCalledWith(USER);
    expect(bustUserCreator).toHaveBeenCalledTimes(1);
    expect(bustUserCreator).toHaveBeenCalledWith(USER, { usernames: ['zavy'] });
  });

  it('refuses a confirmation of a proposal that was replaced after it was viewed', async () => {
    await propose();
    const { proposedAt: viewed } = (await row()).meta.memorial as { proposedAt: string };
    await reverse();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await propose();
    await expect(
      confirmMemorial({ userId: USER, actorId: CONFIRMER, proposedAt: viewed }, effects)
    ).rejects.toThrow(/changed since you opened it/);
    expect((await row()).flags & UserFlag.Memorialized).toBe(0);
  });

  it('still expires the keys when signing out fails, and says sessions were not revoked', async () => {
    invalidateSession.mockImplementation(async () => {
      throw new Error('redis down');
    });
    await propose();
    const result = await confirm(CONFIRMER);
    expect(expireUserApiKeys).toHaveBeenCalledWith(USER);
    expect(result).toMatchObject({ sessionsRevoked: false, keysRevoked: true });
  });

  it.each([
    ['banned', 'UPDATE "User" SET "bannedAt" = now() WHERE id = $1', /banned account/],
    ['deleted', 'UPDATE "User" SET "deletedAt" = now() WHERE id = $1', /is deleted/],
  ])('refuses to propose for a %s account', async (_, sql, refusal) => {
    await pg.query(sql, [USER]);
    await expect(propose()).rejects.toThrow(refusal);
    expect((await row()).meta).not.toHaveProperty('memorial');
  });

  it('refuses a second proposal while one is waiting', async () => {
    await propose();
    await expect(
      proposeMemorial({ userId: USER, actorId: CONFIRMER, basis: 'family', tributes: [] })
    ).rejects.toThrow(/already waiting/);
    expect(((await row()).meta.memorial as { proposedBy: number }).proposedBy).toBe(PROPOSER);
  });

  it('refuses to reverse an account that is not memorialized', async () => {
    await expect(reverse()).rejects.toThrow(/not memorialized/);
  });

  it('finds memorialized ids among others, and refuses a memorialized account at the delete check', async () => {
    await pg.query('INSERT INTO "User" (id, username) VALUES ($1, $2)', [USER + 1, 'alive']);
    await propose();
    await confirm(CONFIRMER);
    expect([...(await memorializedAmong([USER, USER + 1]))]).toEqual([USER]);
    const { flags } = await row();
    expect(() => assertNotMemorialized({ flags })).toThrow(MemorializedAccountError);
  });

  it('reverses to the flags the account had, keeping an event exclusion set before it', async () => {
    await pg.query('UPDATE "User" SET flags = $1 WHERE id = $2', [
      UserFlag.ExcludeFromEventPoints,
      USER,
    ]);
    await propose();
    await confirm(CONFIRMER);
    await reverse();

    const { flags, meta } = await row();
    expect(flags).toBe(UserFlag.ExcludeFromEventPoints);
    expect(meta).not.toHaveProperty('memorial');
  });

  it('reverses an exclusion it set itself', async () => {
    await propose();
    await confirm(CONFIRMER);
    await reverse();
    expect((await row()).flags).toBe(0);
  });

  it('refuses an impersonation session even for a moderator who holds the grant', () => {
    expect(memorialActorRefusal({ mayMemorialize: true, impersonatedBy: PROPOSER })).toMatch(
      /impersonating/
    );
    expect(memorialActorRefusal({ mayMemorialize: true, impersonatedBy: null })).toBeNull();
    expect(memorialActorRefusal({ mayMemorialize: false, impersonatedBy: null })).toMatch(
      /user\.memorialize/
    );
  });

  it('reads a meta without the memorial record for the contest-ban list, whatever is stored', async () => {
    await propose();
    await pg.query('INSERT INTO "User" (id, meta) VALUES ($1, $2), ($3, $4)', [
      USER + 2,
      'null',
      USER + 3,
      '[1]',
    ]);
    const { rows } = await pg.query<{ id: number; meta: unknown }>(
      `SELECT id, ${metaWithoutMemorialSql('meta')} AS meta FROM "User" ORDER BY id`
    );
    expect(rows.find((r) => r.id === USER)?.meta).toEqual({});
    expect(rows.find((r) => r.id === USER + 2)?.meta).toBeNull();
    expect(rows.find((r) => r.id === USER + 3)?.meta).toEqual([1]);
  });

  describe('the event-points exclusion start (civitai/civitai#10311)', () => {
    const START = '2026-11-25';
    const setStart = (flags: number) =>
      pg.query('UPDATE "User" SET flags = $1, meta = $2 WHERE id = $3', [
        flags,
        JSON.stringify({ eventPointsExcludedFrom: START }),
        USER,
      ]);

    it('confirm drops a stale start when it sets the exclusion itself, so it is whole-season', async () => {
      await setStart(0);
      await propose();
      await confirm(CONFIRMER);
      expect((await row()).meta).not.toHaveProperty('eventPointsExcludedFrom');
    });

    it('confirm keeps the start of an exclusion that was already set', async () => {
      await setStart(UserFlag.ExcludeFromEventPoints);
      await propose();
      await confirm(CONFIRMER);
      expect((await row()).meta).toMatchObject({ eventPointsExcludedFrom: START });
      await reverse();
      const { flags, meta } = await row();
      expect(flags).toBe(UserFlag.ExcludeFromEventPoints);
      expect(meta).toEqual({ eventPointsExcludedFrom: START });
    });

    it('reverse drops a start when it lifts the exclusion memorializing set', async () => {
      await propose();
      await confirm(CONFIRMER);
      await pg.query(
        `UPDATE "User" SET meta = meta || '{"eventPointsExcludedFrom": "${START}"}' WHERE id = $1`,
        [USER]
      );
      await reverse();
      const { flags, meta } = await row();
      expect(flags).toBe(0);
      expect(meta).toEqual({});
    });
  });
});
