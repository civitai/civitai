import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockedForNamesCsam } from '@civitai/shared/csam-blocked-for';
import {
  csamBlockedSql,
  csamInBlockedFor,
  liftableByUnblock,
  liftableByUnblockSql,
} from '~/server/common/image-visibility';

// `blockedFor` is a comma list of block reasons (a scan writes its audit's reasons joined by ',').
const CASES: [blockedFor: string | null, csam: boolean][] = [
  ['CSAM', true],
  ['tos,CSAM', true],
  ['csam,tos', true],
  ['tos, Csam ', true],
  ['moderated', false],
  ['tos,moderated', false],
  ['csamish', false],
  ['', false],
  [null, false],
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "blockedFor" text, "needsReview" text,
      metadata jsonb);
  `);
  await db.query(
    `INSERT INTO "Image" (id, "blockedFor", metadata)
     SELECT n, b, jsonb_build_object('prior', b) FROM unnest($1::int[], $2::text[]) AS t(n, b)`,
    [CASES.map((_, n) => n), CASES.map(([blockedFor]) => blockedFor)]
  );
});
afterAll(() => db?.close());

const matching = async (where: Prisma.Sql) =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "Image" WHERE ${where.text} ORDER BY id`,
      where.values as unknown[]
    )
  ).rows.map((row) => row.id);

const expected = (csam: boolean) => CASES.flatMap(([, isCsam], n) => (isCsam === csam ? [n] : []));

describe('a CSAM block in a comma list of block reasons', () => {
  it('is read the same by the SQL and the JS predicate', async () => {
    expect(await matching(Prisma.sql`${csamBlockedSql()}`)).toEqual(expected(true));
    expect(CASES.map(([blockedFor]) => blockedForNamesCsam(blockedFor))).toEqual(
      CASES.map(([, csam]) => csam)
    );
  });

  it('is read the same in a recorded prior value', async () => {
    expect(await matching(csamInBlockedFor(Prisma.sql`("metadata"->>'prior')`))).toEqual(
      expected(true)
    );
  });

  it('keeps an unblock from lifting the image, in the pre-check and in the statement', async () => {
    expect(await matching(liftableByUnblockSql)).toEqual(expected(false));
    expect(
      CASES.map(([blockedFor]) => liftableByUnblock({ blockedFor, needsReview: null }))
    ).toEqual(CASES.map(([, csam]) => !csam));
  });
});
