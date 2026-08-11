import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { listModelEngagements } from '@civitai/db-queries/model';
import {
  listImageTagVotes,
  listImageTagVotesMany,
  listModelTagVotes,
} from '@civitai/db-queries/tag';
import { compileHarness } from '@civitai/db-queries/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Behaviour-parity gate for the hot read queries ported from Prisma to Kysely-over-pg.
 *
 * The port exists to keep these statements off the Prisma query engine. That is only safe if the
 * two paths are indistinguishable to the caller, so this suite runs BOTH against the SAME rows in
 * the SAME database and deep-compares — rather than asserting the Kysely result against a hand
 * written expectation, which would only re-state what the new code does.
 *
 * Opt-in via `KYSELY_PARITY_DATABASE_URL`, which must point at a THROWAWAY database: the suite
 * drops and recreates its tables and writes fixture rows. It deliberately does NOT fall back to
 * `DATABASE_URL` — that variable points at a real environment in every checkout that has one.
 *
 *   docker run -d --rm --name pg-parity -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=parity \
 *     -p 54329:5432 postgres:17
 *   KYSELY_PARITY_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/parity \
 *     pnpm vitest run --project unit src/server/db/__tests__/kysely-prisma-parity.test.ts
 */
const parityUrl = process.env.KYSELY_PARITY_DATABASE_URL;

// `$executeRawUnsafe` sends one prepared statement, so the DDL script is applied statement by
// statement. A naive split on `;` is safe for this fixture: it is plain DDL with no function bodies,
// dollar-quoting or semicolons inside literals.
const schemaStatements = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/kysely-parity-schema.sql'),
  'utf-8'
)
  .split(';')
  .map((statement) =>
    statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
  )
  .filter(Boolean);

// Row order is unspecified on both paths (neither query has an ORDER BY, matching the source), so
// parity is a multiset comparison: sort both sides by a total key before comparing.
const sortRows = <T extends Record<string, unknown>>(rows: T[]): T[] =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const expectParity = <T extends Record<string, unknown>>(kysely: T[], prisma: T[]) => {
  expect(sortRows(kysely)).toEqual(sortRows(prisma));
};

// Every query this PR ported, with arguments that reach the statement (a bulk query's empty-array
// guard short-circuits before compiling anything). The array-column seam guard below runs each one
// and reads the select list back off EVERY statement it compiles, so adding a port here is what
// extends the check — there is no second list to keep in sync.
const PORTED_QUERIES: Array<[name: string, run: (db: Kysely<DB>) => Promise<unknown>]> = [
  ['listImageTagVotes', (db) => listImageTagVotes(db, { imageId: 1, userId: 1 })],
  ['listImageTagVotesMany', (db) => listImageTagVotesMany(db, { imageIds: [1], userId: 1 })],
  ['listModelTagVotes', (db) => listModelTagVotes(db, { modelId: 1, userId: 1 })],
  ['listModelEngagements', (db) => listModelEngagements(db, { userId: 1, modelIds: [1] })],
];

/**
 * The (table, column) pairs a compiled single-table SELECT reads.
 *
 * THROWS rather than returning [] on anything it does not fully understand — a join, an alias, an
 * expression, a `select *`. An unparsed statement returning an empty set is indistinguishable from
 * a statement that selects nothing dangerous, and that silent zero is precisely how the previous
 * version of this guard came to be vacuous. If a port outgrows this shape, this has to be taught
 * the new shape; it may not degrade quietly.
 */
function selectedColumns(name: string, sql: string): Array<[table: string, column: string]> {
  const match = /^select (.+?) from "([^"]+)"(?: where | order by |$)/.exec(sql);
  if (!match)
    throw new Error(`selectedColumns(${name}): not a simple single-table select — ${sql}`);
  const [, list, table] = match;
  const items = list.split(',').map((item) => item.trim());
  const unrecognised = items.filter((item) => !/^"[^"]+"$/.test(item));
  if (unrecognised.length)
    throw new Error(
      `selectedColumns(${name}): unrecognised select item(s) [${unrecognised.join(', ')}] — ${sql}`
    );
  return items.map((item) => [table, item.slice(1, -1)]);
}

describe.skipIf(!parityUrl)('Kysely ports return exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl });
  const { db: kysely } = createKyselyClients<DB>({
    connectionString: parityUrl,
    singleClient: true,
  });

  const USER = 1;
  const OTHER_USER = 2;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    // Two users, several images/models, both vote polarities, and every engagement type — so a
    // filter dropped in the port shows up as extra rows rather than as an empty diff.
    await prisma.tagsOnImageVote.createMany({
      data: [
        { imageId: 10, tagId: 100, userId: USER, vote: 1 },
        { imageId: 10, tagId: 101, userId: USER, vote: -1 },
        { imageId: 10, tagId: 102, userId: OTHER_USER, vote: 1 },
        { imageId: 11, tagId: 103, userId: USER, vote: 1 },
        { imageId: 12, tagId: 104, userId: USER, vote: -1 },
      ],
    });
    await prisma.tagsOnModelsVote.createMany({
      data: [
        { modelId: 20, tagId: 200, userId: USER, vote: 1 },
        { modelId: 20, tagId: 201, userId: USER, vote: -1 },
        { modelId: 20, tagId: 202, userId: OTHER_USER, vote: 1 },
        { modelId: 21, tagId: 203, userId: USER, vote: 1 },
      ],
    });
    await prisma.modelEngagement.createMany({
      data: [
        { userId: USER, modelId: 30, type: 'Favorite' },
        { userId: USER, modelId: 31, type: 'Hide' },
        { userId: USER, modelId: 32, type: 'Mute' },
        { userId: USER, modelId: 33, type: 'Notify' },
        { userId: OTHER_USER, modelId: 30, type: 'Favorite' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await kysely.destroy();
  });

  describe('listImageTagVotes', () => {
    const viaPrisma = (imageId: number, userId: number) =>
      prisma.tagsOnImageVote.findMany({
        where: { imageId, userId },
        select: { tagId: true, vote: true },
      });

    it('matches Prisma for an image the user voted on, including a negative vote', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotes(kysely, { imageId: 10, userId: USER }),
        viaPrisma(10, USER),
      ]);
      expect(k).toHaveLength(2); // positive control: the comparison is not two empty arrays
      expectParity(k, p);
    });

    it('matches Prisma (empty) for an image the user has not voted on', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotes(kysely, { imageId: 99, userId: USER }),
        viaPrisma(99, USER),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });

    it('excludes other users votes on the same image, exactly as Prisma did', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotes(kysely, { imageId: 10, userId: OTHER_USER }),
        viaPrisma(10, OTHER_USER),
      ]);
      expect(k).toEqual([{ tagId: 102, vote: 1 }]);
      expectParity(k, p);
    });

    it('returns vote as a JS number, not a string', async () => {
      const [row] = await listImageTagVotes(kysely, { imageId: 10, userId: USER });
      expect(typeof row.vote).toBe('number');
      expect(typeof row.tagId).toBe('number');
    });
  });

  describe('listImageTagVotesMany', () => {
    const viaPrisma = (imageIds: number[], userId: number) =>
      prisma.tagsOnImageVote.findMany({
        where: { imageId: { in: imageIds }, userId },
        select: { tagId: true, vote: true },
      });

    it('matches Prisma across several images', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotesMany(kysely, { imageIds: [10, 11, 12], userId: USER }),
        viaPrisma([10, 11, 12], USER),
      ]);
      expect(k).toHaveLength(4);
      expectParity(k, p);
    });

    it('matches Prisma for a subset that excludes some seeded images', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotesMany(kysely, { imageIds: [11], userId: USER }),
        viaPrisma([11], USER),
      ]);
      expect(k).toEqual([{ tagId: 103, vote: 1 }]);
      expectParity(k, p);
    });

    it('matches Prisma (empty) for an empty imageIds array instead of raising IN ()', async () => {
      // Prisma compiled `{ in: [] }` to an empty result; Kysely would compile `IN ()`, a Postgres
      // syntax error, without the guard. Reachable from a request: the votable-tag input schema
      // accepts an empty `ids` array.
      const [k, p] = await Promise.all([
        listImageTagVotesMany(kysely, { imageIds: [], userId: USER }),
        viaPrisma([], USER),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });

    it('matches Prisma (empty) for image ids that exist but hold no votes for this user', async () => {
      const [k, p] = await Promise.all([
        listImageTagVotesMany(kysely, { imageIds: [11, 12], userId: OTHER_USER }),
        viaPrisma([11, 12], OTHER_USER),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });
  });

  describe('listModelTagVotes', () => {
    const viaPrisma = (modelId: number, userId: number) =>
      prisma.tagsOnModelsVote.findMany({
        where: { modelId, userId },
        select: { tagId: true, vote: true },
      });

    it('matches Prisma for a model the user voted on', async () => {
      const [k, p] = await Promise.all([
        listModelTagVotes(kysely, { modelId: 20, userId: USER }),
        viaPrisma(20, USER),
      ]);
      expect(k).toHaveLength(2);
      expectParity(k, p);
    });

    it('matches Prisma (empty) for a model the user has not voted on', async () => {
      const [k, p] = await Promise.all([
        listModelTagVotes(kysely, { modelId: 99, userId: USER }),
        viaPrisma(99, USER),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });
  });

  describe('listModelEngagements', () => {
    const viaPrisma = (userId: number, modelIds: number[]) =>
      prisma.modelEngagement.findMany({
        where: { userId, modelId: { in: modelIds } },
        select: { modelId: true, type: true },
      });

    it('matches Prisma across every engagement type', async () => {
      const [k, p] = await Promise.all([
        listModelEngagements(kysely, { userId: USER, modelIds: [30, 31, 32, 33] }),
        viaPrisma(USER, [30, 31, 32, 33]),
      ]);
      expect(k).toHaveLength(4);
      expectParity(k, p);
    });

    it('returns the scalar enum as its string value, exactly as Prisma did', async () => {
      // ModelEngagementType is a SCALAR enum: pg reads it back as plain text with no parser
      // registration. The array-of-enum case is the one that arrives as a raw `{a,b}` literal —
      // see the guard below, and @civitai/db/kysely's registerEnumArrayTypeParsers.
      const rows = await listModelEngagements(kysely, { userId: USER, modelIds: [30] });
      expect(rows).toEqual([{ modelId: 30, type: 'Favorite' }]);
      expect(typeof rows[0].type).toBe('string');
    });

    it('matches Prisma (empty) for an empty modelIds array instead of raising IN ()', async () => {
      const [k, p] = await Promise.all([
        listModelEngagements(kysely, { userId: USER, modelIds: [] }),
        viaPrisma(USER, []),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });

    it('matches Prisma (empty) for model ids the user has no engagement with', async () => {
      const [k, p] = await Promise.all([
        listModelEngagements(kysely, { userId: USER, modelIds: [900, 901] }),
        viaPrisma(USER, [900, 901]),
      ]);
      expect(k).toEqual([]);
      expectParity(k, p);
    });

    it('excludes another users engagement with the same model, exactly as Prisma did', async () => {
      const [k, p] = await Promise.all([
        listModelEngagements(kysely, { userId: OTHER_USER, modelIds: [30, 31, 32, 33] }),
        viaPrisma(OTHER_USER, [30, 31, 32, 33]),
      ]);
      expect(k).toEqual([{ modelId: 30, type: 'Favorite' }]);
      expectParity(k, p);
    });
  });

  // Seam guard. The Kysely-over-pg path has no parser for an ARRAY of a user-defined enum unless
  // registerEnumArrayTypeParsers has run, so such a column silently arrives as the raw Postgres
  // literal `{a,b}` where the inferred type promises string[]. None of the columns these ports
  // select is an array type today, which is why they need no registration.
  //
  // The column set is DERIVED FROM THE COMPILED SQL of the real query functions, so it tracks the
  // query rather than a maintainer's memory: widening a select onto an enum-array column
  // (`Tag.target` is the nearby example) puts that column into the set below without anyone
  // editing this test. The predecessor of this guard was a hand-written literal list, which is
  // exactly the shape that cannot fail — an audit widened `listModelEngagements` onto a real
  // `"ModelEngagementType"[]` column and the guard passed.
  //
  // What it is checked against is the catalog of the FIXTURE database this suite creates from
  // `fixtures/kysely-parity-schema.sql` — not the production catalog. The fixture mirrors the
  // real column types for these three tables, so it answers the array-vs-scalar question; it is
  // not evidence about any column the fixture does not declare.
  it('no ported query selects an array-typed column, so no enum-array parser is required', async () => {
    // Compiled offline against DummyDriver — the SQL is real, nothing executes.
    const harness = compileHarness();
    const selected: Array<[table: string, column: string]> = [];
    for (const [name, run] of PORTED_QUERIES) {
      harness.queries.length = 0;
      await run(harness.db);
      if (!harness.queries.length)
        throw new Error(`${name} compiled no query — the derivation saw nothing`);
      // EVERY statement the call compiled, not just the last one. Reading only `lastQuery()` meant
      // a port that issues two statements was checked on its final statement alone, so an
      // array-typed select in any earlier one passed unseen — the same silent green this guard
      // exists to remove. Verified by mutation: an enum-array select in the FIRST of two.
      for (const compiled of harness.queries) selected.push(...selectedColumns(name, compiled.sql));
    }

    // Positive control on the derivation's YIELD. A parse that silently produced nothing would make
    // every assertion below pass vacuously, which is the failure this guard replaced. 4 queries × 2
    // columns today; widening a select, or a port growing a second statement, only ever raises it.
    expect(selected.length).toBeGreaterThanOrEqual(8);

    const tables = [...new Set(selected.map(([table]) => table))];
    // Every attribute of the named relations, with whether its type is an array (typcategory 'A').
    // ONE query feeds both checks below, so the control cannot certify a path the assertion does
    // not use.
    const attributesIn = async (relnames: string[]) => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ table: string; column: string; isArray: boolean }>
      >(
        `SELECT c.relname AS "table", a.attname AS "column", (t.typcategory = 'A') AS "isArray"
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attnum > 0
            AND NOT a.attisdropped
            AND c.relname = ANY($1::text[])`,
        relnames
      );
      const qualify = (r: { table: string; column: string }) => `${r.table}.${r.column}`;
      return {
        all: new Set(rows.map(qualify)),
        arrays: new Set(rows.filter((r) => r.isArray).map(qualify)),
      };
    };

    // Positive control on the CATALOG QUERY, run through the same helper the assertion uses: it
    // CAN see an enum-array column when one exists.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "_ParityArrayProbe" (x "ModelEngagementType"[])`
    );
    expect([...(await attributesIn(['_ParityArrayProbe'])).arrays]).toEqual([
      '_ParityArrayProbe.x',
    ]);

    const { all, arrays } = await attributesIn(tables);
    const qualified = selected.map(([table, column]) => `${table}.${column}`);

    // Positive control on the derivation's CONTENT — the seam between "a name was derived" and "the
    // catalog can match it", which neither control above covers. Counting items cannot tell a real
    // column name from a mangled one, and a mangled name matches NOTHING, so `offenders` would be
    // permanently empty and the assertion below permanently green while the hazard existed.
    // Verified by mutation: dropping one character from the unquoting in `selectedColumns`
    // (`slice(1, -1)` → `slice(1)`) fires exactly this, and nothing else.
    const unknown = qualified.filter((name) => !all.has(name));
    expect(
      unknown,
      `derived column name(s) match no catalog column [${unknown.join(', ')}] — the select-list ` +
        `derivation is broken, so the array check below cannot fail and would prove nothing`
    ).toEqual([]);

    const offenders = qualified.filter((name) => arrays.has(name));
    expect(
      offenders,
      `ported query selects ARRAY-typed column(s) [${offenders.join(
        ', '
      )}] — pg returns an array ` +
        `of a user-defined enum as the raw '{a,b}' literal unless registerEnumArrayTypeParsers ` +
        `has run, and none of these ports registers one`
    ).toEqual([]);
  });
});
