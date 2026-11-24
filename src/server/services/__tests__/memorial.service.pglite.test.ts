import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { proposeMemorial, confirmMemorial, reverseMemorial, publicMemorial } = await import(
  '~/server/services/memorial.service'
);

// Redis, the signals service and the orchestrator: what confirming reaches outside the database.
const invalidateSession = vi.fn(async () => undefined);
const expireUserApiKeys = vi.fn(async () => ({ expired: 2, orchestratorConfirmed: true }));
const effects = {
  invalidateSession,
  expireUserApiKeys,
  bustUserCreator: vi.fn(async () => undefined),
};
const confirm = (actorId: number) => confirmMemorial({ userId: USER, actorId }, effects);
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

describe('memorialization', () => {
  it('changes nothing public until a second moderator confirms', async () => {
    await propose();
    const { flags, meta } = await row();
    expect(flags & UserFlag.Memorialized).toBe(0);
    expect(publicMemorial(meta)).toBeNull();
  });

  it('refuses a confirmation by the moderator who proposed it', async () => {
    await propose();
    await expect(confirm(PROPOSER)).rejects.toThrow(/different moderator/);
    expect((await row()).flags & UserFlag.Memorialized).toBe(0);
    expect(invalidateSession).not.toHaveBeenCalled();
    expect(expireUserApiKeys).not.toHaveBeenCalled();
  });

  it('on a second moderator, memorializes, signs the account out and expires its keys', async () => {
    await propose();
    await confirm(CONFIRMER);

    const { flags, meta } = await row();
    expect(flags & UserFlag.Memorialized).toBe(UserFlag.Memorialized);
    expect(flags & UserFlag.ExcludeFromEventPoints).toBe(UserFlag.ExcludeFromEventPoints);
    // Only the tributes reach a profile: not who proposed it, nor how the death was confirmed.
    expect(publicMemorial(meta)).toEqual({ tributes: [TRIBUTE] });
    expect(invalidateSession).toHaveBeenCalledWith(USER, 'moderation');
    expect(expireUserApiKeys).toHaveBeenCalledWith(USER);
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
});
