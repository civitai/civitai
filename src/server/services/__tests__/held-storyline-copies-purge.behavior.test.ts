import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { heldStorylineCopiesSchemaSql } from '~/server/services/__tests__/held-copies.fixture';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';

/**
 * The daily purge of deleted storylines' copies, on a Postgres stand-in so the shipped SQL decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OLD = 1; // deleted over a year ago, no open report
const RECENT = 2; // deleted under a year ago
const REPORTED_INLINE = 3; // over a year ago, an open report recorded on the copy
const REPORTED_LINKED = 4; // over a year ago, an open report pointing at the copy
const CLOSED = 5; // over a year ago, its report since actioned
const ORPHAN_STORYLINE = 9; // chapter copies with no storyline copy, from an old chapter removal
const READER = 99;

let db: PGlite;
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(heldStorylineCopiesSchemaSql());
});

afterAll(async () => {
  await db.close();
});

const storyline = (id: number, age: string, reportIds = '{}') => `
  INSERT INTO "HeldStoryline" (id, "userId", title, "createdAt", "deletedAt", "deletedById", "reportIds")
    VALUES (${id}, 7, 't', now() - interval '3 years', now() - interval '${age}', 7, '${reportIds}');`;

const chapter = (storylineId: number) => {
  const id = storylineId * 10;
  return `
    INSERT INTO "HeldStorylineChapter" (id, "storylineId", "userId", depth, "createdAt", "ownerId", "authorId")
      VALUES (${id}, ${storylineId}, 7, 1, now(), 7, 7);
    INSERT INTO "HeldStorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon,
      "createdAt", "ownerId", "authorId") VALUES (${storylineId}, ${id}, 1, true, now(), 7, 7);
    INSERT INTO "HeldStorylineBranchChoice" ("userId", "parentChapterId", "chapterId", "createdAt",
      "updatedAt", "ownerId", "authorId") VALUES (${READER}, 1, ${id}, now(), now(), 7, 7);
    INSERT INTO "HeldStorylineCreateClick" ("userId", "parentChapterId", "createdAt", "ownerId",
      "authorId") VALUES (${READER}, ${id}, now(), 7, 7);`;
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "Report", "StorylineReport", "HeldStoryline", "HeldStorylineChapter",
      "HeldStorylineChapterEdge", "HeldStorylineBranchChoice", "HeldStorylineCreateClick";
    INSERT INTO "Report" (id, status) VALUES (1, 'Pending'), (2, 'Processing'), (3, 'Actioned');
    ${storyline(OLD, '400 days')}
    ${storyline(RECENT, '300 days')}
    ${storyline(REPORTED_INLINE, '400 days', '{1}')}
    ${storyline(REPORTED_LINKED, '400 days')}
    ${storyline(CLOSED, '400 days', '{3}')}
    INSERT INTO "StorylineReport" ("storylineId", "reportId", "heldStorylineId")
      VALUES (NULL, 2, ${REPORTED_LINKED});
    ${[OLD, RECENT, REPORTED_INLINE, REPORTED_LINKED, CLOSED, ORPHAN_STORYLINE]
      .map(chapter)
      .join('')}
  `);
  const viaStandIn = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = asSql(first, values);
    return (await db.query(sql.text, sql.values as unknown[])).rows;
  }) as never;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(viaStandIn);
});

const left = async () => {
  const ids = async (sql: string) => (await db.query<{ id: number }>(sql)).rows.map((r) => r.id);
  return {
    storylines: await ids(`SELECT id FROM "HeldStoryline" ORDER BY 1`),
    chapters: await ids(`SELECT id FROM "HeldStorylineChapter" ORDER BY 1`),
    edges: await ids(`SELECT "chapterId" AS id FROM "HeldStorylineChapterEdge" ORDER BY 1`),
    choices: await ids(`SELECT "chapterId" AS id FROM "HeldStorylineBranchChoice" ORDER BY 1`),
    clicks: await ids(`SELECT "parentChapterId" AS id FROM "HeldStorylineCreateClick" ORDER BY 1`),
  };
};

describe('purging deleted storylines’ copies', () => {
  it('drops a copy over a year old with no open report, with its chapter copies and orphans', async () => {
    expect(await purgeReleasedHeldCopies()).toEqual({
      storylines: 2,
      chapters: 3,
      edges: 3,
      choices: 3,
      clicks: 3,
    });

    const kept = [RECENT, REPORTED_INLINE, REPORTED_LINKED];
    const keptChapters = kept.map((id) => id * 10);
    expect(await left()).toEqual({
      storylines: kept,
      chapters: keptChapters,
      edges: keptChapters,
      choices: keptChapters,
      clicks: keptChapters,
    });
  });

  it('drops a reported copy once its report closes', async () => {
    await db.exec(`UPDATE "Report" SET status = 'Actioned'`);

    await purgeReleasedHeldCopies();
    expect((await left()).storylines).toEqual([RECENT]);
  });
});
