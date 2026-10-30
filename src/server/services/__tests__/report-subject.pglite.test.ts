import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OWNED_REPORT_TABLES } from '@civitai/shared/report-subjects';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { reportConcernsUser } from '~/server/services/report-subject';

const SUBJECT = 501;
const OTHER = 502;
const REPORTER = 503;
const SYSTEM = -1;

let db: PGlite;
let nextId = 1;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Report" (id int PRIMARY KEY, "userId" int NOT NULL, "alsoReportedBy" int[] NOT NULL DEFAULT '{}');
    CREATE TABLE "UserReport" ("reportId" int NOT NULL, "userId" int NOT NULL);
    CREATE TABLE "ChatReport" ("reportId" int NOT NULL, "chatId" int NOT NULL);
    CREATE TABLE "ChatMember" ("chatId" int NOT NULL, "userId" int NOT NULL);
    ${OWNED_REPORT_TABLES.map(
      ({ reportTable, fk, table, ownerColumn }) => `
      CREATE TABLE "${table}" (id int PRIMARY KEY, "${ownerColumn}" int);
      CREATE TABLE "${reportTable}" ("reportId" int NOT NULL, "${fk}" int NOT NULL);`
    ).join('\n')}
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(db).queryRaw as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  nextId = 1;
  await db.exec(
    ['Report', 'UserReport', 'ChatReport', 'ChatMember']
      .concat(OWNED_REPORT_TABLES.flatMap((t) => [t.table, t.reportTable]))
      .map((t) => `DELETE FROM "${t}";`)
      .join('\n')
  );
});

async function report(reporter = REPORTER, alsoReportedBy: number[] = []) {
  const id = nextId++;
  await db.query(`INSERT INTO "Report" (id, "userId", "alsoReportedBy") VALUES ($1, $2, $3)`, [
    id,
    reporter,
    alsoReportedBy,
  ]);
  return id;
}

async function chat(members: number[]) {
  const chatId = nextId++;
  for (const userId of members)
    await db.query(`INSERT INTO "ChatMember" ("chatId", "userId") VALUES ($1, $2)`, [
      chatId,
      userId,
    ]);
  return chatId;
}

async function chatReport(members: number[], reporter = REPORTER, alsoReportedBy: number[] = []) {
  const chatId = await chat(members);
  const id = await report(reporter, alsoReportedBy);
  await db.query(`INSERT INTO "ChatReport" ("reportId", "chatId") VALUES ($1, $2)`, [id, chatId]);
  return id;
}

/** A report of each type whose subject is `SUBJECT`. */
const fileAbout: Record<string, () => Promise<number>> = {
  ...Object.fromEntries(
    OWNED_REPORT_TABLES.map(({ reportTable, fk, table, ownerColumn }) => [
      reportTable,
      async () => {
        const thing = nextId++;
        await db.query(`INSERT INTO "${table}" (id, "${ownerColumn}") VALUES ($1, $2)`, [
          thing,
          SUBJECT,
        ]);
        const id = await report();
        await db.query(`INSERT INTO "${reportTable}" ("reportId", "${fk}") VALUES ($1, $2)`, [
          id,
          thing,
        ]);
        return id;
      },
    ])
  ),
  UserReport: async () => {
    const id = await report();
    await db.query(`INSERT INTO "UserReport" ("reportId", "userId") VALUES ($1, $2)`, [
      id,
      SUBJECT,
    ]);
    return id;
  },
  ChatReport: () => chatReport([REPORTER, SUBJECT]),
};

describe('reportConcernsUser', () => {
  it('covers all 21 report types', () => {
    expect(Object.keys(fileAbout)).toHaveLength(21);
  });

  it.each(Object.keys(fileAbout))(
    '%s: true for its subject, false for anyone else',
    async (type) => {
      const id = await fileAbout[type]();
      expect(await reportConcernsUser(id, SUBJECT)).toBe(true);
      expect(await reportConcernsUser(id, OTHER)).toBe(false);
    }
  );

  it('false for a report that does not exist, or whose type it cannot resolve', async () => {
    expect(await reportConcernsUser(9999, SUBJECT)).toBe(false);
    expect(await reportConcernsUser(await report(), SUBJECT)).toBe(false);
  });

  describe('chat reports', () => {
    it('never names the reporter, nor someone who also reported it', async () => {
      expect(await reportConcernsUser(await chatReport([REPORTER, SUBJECT]), REPORTER)).toBe(false);
      const id = await chatReport([REPORTER, SUBJECT], REPORTER, [SUBJECT]);
      expect(await reportConcernsUser(id, SUBJECT)).toBe(false);
    });

    it('names nobody on an automated report, whose reporter is in no chat', async () => {
      const id = await chatReport([OTHER, SUBJECT], SYSTEM);
      expect(await reportConcernsUser(id, SUBJECT)).toBe(false);
      expect(await reportConcernsUser(id, OTHER)).toBe(false);
    });

    it('names nobody in a group chat', async () => {
      const id = await chatReport([REPORTER, SUBJECT, OTHER]);
      expect(await reportConcernsUser(id, SUBJECT)).toBe(false);
    });
  });
});
