import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  heldCopiesSchemaSql,
  heldStorylineCopiesSchemaSql,
} from '~/server/services/__tests__/held-copies.fixture';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';

/**
 * The daily purge of storyline chapter copies, which a chapter removal keeps while its owner or
 * author is held. Run on a Postgres stand-in, so the hold legs that decide are the shipped SQL.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const FREE = 3;
const REPORTED = 2; // named on a pending report
const MARKED = 4; // held only by a hold marker
const SENT_RECENTLY = 5; // named on a report sent and archived under a year ago
const SENT_LONG_AGO = 6; // named on a report sent and archived over a year ago
const READER = 99; // an account since deleted: no row anywhere

let db: PGlite;
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
  `);
  await db.exec(heldCopiesSchemaSql());
  await db.exec(heldStorylineCopiesSchemaSql());
});

afterAll(async () => {
  await db.close();
});

/** Chapter copies by id, with who owned the storyline and who wrote the chapter. */
const COPIES: [chapterId: number, ownerId: number, authorId: number][] = [
  [10, FREE, FREE],
  [11, REPORTED, FREE],
  [12, FREE, MARKED],
  [13, FREE, SENT_RECENTLY],
  [14, SENT_LONG_AGO, FREE],
  [15, PLACEHOLDER_OWNER_ID, FREE],
  [16, PLACEHOLDER_OWNER_ID, MARKED],
];

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "CsamReport", "EvidenceHold", "HeldStorylineChapter", "HeldStorylineChapterEdge",
      "HeldStorylineBranchChoice", "HeldStorylineCreateClick";
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED});
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
      VALUES (${SENT_RECENTLY}, now() - interval '300 days', now() - interval '300 days'),
        (${SENT_LONG_AGO}, now() - interval '400 days', now() - interval '400 days');
    INSERT INTO "EvidenceHold" VALUES (${MARKED});
  `);
  for (const [id, ownerId, authorId] of COPIES)
    await db.exec(`
      INSERT INTO "HeldStorylineChapter" (id, "storylineId", "userId", depth, "createdAt",
        "ownerId", "authorId") VALUES (${id}, 1, ${authorId}, 1, now(), ${ownerId}, ${authorId});
      INSERT INTO "HeldStorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon,
        "createdAt", "ownerId", "authorId") VALUES (1, ${id}, 1, true, now(), ${ownerId}, ${authorId});
      INSERT INTO "HeldStorylineBranchChoice" ("userId", "parentChapterId", "chapterId", "createdAt",
        "updatedAt", "ownerId", "authorId")
        VALUES (${READER}, 1, ${id}, now(), now(), ${ownerId}, ${authorId});
      INSERT INTO "HeldStorylineCreateClick" ("userId", "parentChapterId", "createdAt", "ownerId",
        "authorId") VALUES (${READER}, ${id}, now(), ${ownerId}, ${authorId});
    `);
  const viaStandIn = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = asSql(first, values);
    return (await db.query(sql.text, sql.values as unknown[])).rows;
  }) as never;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never);
});

const left = async () => {
  const ids = async (sql: string) => (await db.query<{ id: number }>(sql)).rows.map((r) => r.id);
  return {
    chapters: await ids(`SELECT id FROM "HeldStorylineChapter" ORDER BY 1`),
    edges: await ids(`SELECT "chapterId" AS id FROM "HeldStorylineChapterEdge" ORDER BY 1`),
    choices: await ids(`SELECT "chapterId" AS id FROM "HeldStorylineBranchChoice" ORDER BY 1`),
    clicks: await ids(`SELECT "parentChapterId" AS id FROM "HeldStorylineCreateClick" ORDER BY 1`),
  };
};
const everywhere = (ids: number[]) => ({ chapters: ids, edges: ids, choices: ids, clicks: ids });

describe('purging held storyline chapter copies', () => {
  it('drops a copy once neither its owner nor its author is held, and keeps the rest', async () => {
    const { storyline } = await purgeReleasedHeldCopies();

    // 10: no one held. 14: the only report was sent and archived over a year ago. 15: the
    // placeholder owner is not held forever.
    expect(storyline).toEqual({ chapters: 3, edges: 3, choices: 3, clicks: 3 });
    // 11, 12 and 16: owner or author held. 13: the report was sent under a year ago. Their
    // readers' rows stay with them, though the reader's account is gone.
    expect(await left()).toEqual(everywhere([11, 12, 13, 16]));
  });

  it('releases the rest as their holds end', async () => {
    await purgeReleasedHeldCopies();
    await db.exec(`DELETE FROM "CsamReport"; DELETE FROM "EvidenceHold";`);

    const { storyline } = await purgeReleasedHeldCopies();
    expect(storyline).toEqual({ chapters: 4, edges: 4, choices: 4, clicks: 4 });
    expect(await left()).toEqual(everywhere([]));
  });

  // A hold placed between two statements must not leave a chapter's copy without its edges.
  it('purges the four tables in one statement', async () => {
    await purgeReleasedHeldCopies();
    const statements = [
      ...vi.mocked(dbMock.dbWrite.$queryRaw).mock.calls,
      ...vi.mocked(dbMock.dbWrite.$executeRaw).mock.calls,
    ].map(([first, ...values]) => asSql(first as TemplateStringsArray, values).sql);
    expect(statements.filter((sql) => sql.includes('"HeldStoryline'))).toHaveLength(1);
  });
});
