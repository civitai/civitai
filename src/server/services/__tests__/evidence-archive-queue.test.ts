import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { archiveQueueStates } from '@civitai/db-queries/evidence-archive-queue';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * Which reports the separate archiver's queue lists, read the way its poll reads a row, against real
 * tables. All ids are invented.
 */

const pg = { db: null as unknown as PGlite };
const db = pgliteKysely(() => pg.db);
const DAY = 24 * 60;

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "JobQueue" (
      type text NOT NULL, "entityType" text NOT NULL, "entityId" int NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), data jsonb,
      PRIMARY KEY ("entityType", "entityId", type)
    );
  `);
});
afterAll(() => pg.db.close());
beforeEach(() => pg.db.exec(`DELETE FROM "JobQueue"; DELETE FROM "CsamReport";`));

async function report(id: number, userId: number) {
  await pg.db.query(`INSERT INTO "CsamReport" (id, "userId") VALUES ($1, $2)`, [id, userId]);
}
async function row(
  userId: number,
  data: unknown,
  { type = 'CsamArchive', age = '0 minutes' } = {}
) {
  await pg.db.query(
    `INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt", data)
     VALUES ($1, 'User', $2, now() - $3::interval, $4::jsonb)`,
    [type, userId, age, JSON.stringify(data)]
  );
}

describe('archiveQueueStates', () => {
  it('lists a report its user row holds as a JSON number, and leaves out the rest', async () => {
    await report(11, 501);
    await report(12, 501);
    await row(501, { reportIds: [11] });
    const states = await archiveQueueStates(db, [11, 12], DAY);
    expect([...states]).toEqual([[11, 'queued']]);
  });

  it('does not list a report the poll would not run, and never throws on a malformed row', async () => {
    await report(21, 601); // string id
    await row(601, { reportIds: ['21'] });
    await report(22, 602); // reportIds not an array
    await row(602, { reportIds: 22 });
    await report(23, 603); // data not an object
    await row(603, [23]);
    await report(24, 604); // listed in another user's row
    await row(699, { reportIds: [24] });
    await report(25, 605); // another queue type
    await row(605, { reportIds: [25] }, { type: 'CleanUp' });
    const states = await archiveQueueStates(db, [21, 22, 23, 24, 25], DAY);
    expect([...states]).toEqual([]);
  });

  it('reads a row with an error or a repeated claim as failing, and an old one as overdue', async () => {
    await report(31, 701);
    await row(701, { reportIds: [31], lastError: 'Error' });
    await report(32, 702);
    await row(702, { reportIds: [32], attempts: 2 });
    await report(33, 703);
    await row(703, { reportIds: [33], attempts: 1 }, { age: '2 days' });
    await report(34, 704);
    await row(704, { reportIds: [34], attempts: 1 });
    const states = await archiveQueueStates(db, [31, 32, 33, 34], DAY);
    expect(Object.fromEntries(states)).toEqual({
      31: 'failing',
      32: 'failing',
      33: 'overdue',
      34: 'queued',
    });
  });
});
