import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** Which users count as named on a CSAM report before a moderator changes their profile, against Postgres. */

const SCHEMA = `
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}',
  "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3)
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER NOT NULL, "role" TEXT NOT NULL);
`;

let pg: PGlite;

const { archiveProfileBeforeModeratorChange } = await import('~/server/services/user.service');

const USER = 990300001;
const OTHER = 990300002;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
  dbMock.dbWrite.userProfile.findUnique.mockResolvedValue({ bio: 'b' } as never);
  dbMock.dbWrite.userLink.findMany.mockResolvedValue([] as never);
  await pg.exec(`DELETE FROM "CsamReport"; DELETE FROM "EvidenceHeldUser"`);
});

const archived = async () => {
  const archive = vi.fn(async () => undefined);
  await archiveProfileBeforeModeratorChange({ userId: USER, actorId: 7, fields: ['bio'], archive });
  return archive.mock.calls.length > 0;
};

describe('archiveProfileBeforeModeratorChange report match', () => {
  it('archives the subject of a report', async () => {
    await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [USER]);
    expect(await archived()).toBe(true);
  });

  it('archives the secondary user, stored as a number', async () => {
    await pg.query(`INSERT INTO "CsamReport" ("userId", details) VALUES ($1, $2)`, [
      OTHER,
      JSON.stringify({ secondaryUserId: USER }),
    ]);
    expect(await archived()).toBe(true);
  });

  it('archives the secondary user, stored as a string', async () => {
    await pg.query(`INSERT INTO "CsamReport" ("userId", details) VALUES ($1, $2)`, [
      OTHER,
      JSON.stringify({ secondaryUserId: String(USER) }),
    ]);
    expect(await archived()).toBe(true);
  });

  it('archives a user held only by a manual evidence hold', async () => {
    await pg.query(`INSERT INTO "EvidenceHeldUser" ("userId", role) VALUES ($1, 'manual')`, [USER]);
    expect(await archived()).toBe(true);
  });

  it('archives the subject of a report that no longer holds', async () => {
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
       VALUES ($1, now() - interval '2 years', now() - interval '2 years')`,
      [USER]
    );
    expect(await archived()).toBe(true);
  });

  it('archives nothing for a user only other reports name', async () => {
    await pg.query(`INSERT INTO "CsamReport" ("userId", details) VALUES ($1, $2)`, [
      OTHER,
      JSON.stringify({ secondaryUserId: OTHER + 1 }),
    ]);
    expect(await archived()).toBe(false);
  });
});
