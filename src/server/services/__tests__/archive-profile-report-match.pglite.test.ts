import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** Which users count as named on a CSAM report before a moderator changes their profile, against Postgres. */

const SCHEMA = `
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "details" JSONB NOT NULL DEFAULT '{}'
);
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
  await pg.exec(`DELETE FROM "CsamReport"`);
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

  it('archives nothing for a user only other reports name', async () => {
    await pg.query(`INSERT INTO "CsamReport" ("userId", details) VALUES ($1, $2)`, [
      OTHER,
      JSON.stringify({ secondaryUserId: OTHER + 1 }),
    ]);
    expect(await archived()).toBe(false);
  });
});
