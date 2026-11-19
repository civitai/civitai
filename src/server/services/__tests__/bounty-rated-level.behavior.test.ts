import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getTextRatedBountyLevels } from '~/server/services/bounty-rated-level';
import { BOUNTY_SCAN_DETAILS_KEY } from '~/server/utils/bounty-details';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The feed and page tests hand getTextRatedBountyLevels its rows through a mocked $queryRaw, so
// only the real statement on real rows can show its marker test, status check and join are right.

const pg = { db: null as unknown as PGlite };
const marker = JSON.stringify({ [BOUNTY_SCAN_DETAILS_KEY]: { at: '2026-01-01' } });
const v1 = `'{"version":"1"}'`;

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending', 'Succeeded', 'Failed', 'Expired', 'Canceled');
    CREATE TABLE "Bounty" ("id" integer PRIMARY KEY, "details" jsonb);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY, "nsfwLevel" integer NOT NULL);
    CREATE TABLE "ImageConnection" ("imageId" integer, "entityType" text, "entityId" integer);
    CREATE TABLE "EntityModeration" (
      "entityType" text, "entityId" integer, "status" "EntityModerationStatus",
      "nsfwLevel" integer, "result" jsonb,
      "blocked" boolean NOT NULL DEFAULT false, "triggeredLabels" text[] NOT NULL DEFAULT '{}'
    );
    INSERT INTO "Bounty" VALUES
      (1, '${marker}'),        -- rated R
      (2, '${marker}'),        -- rated R, images X
      (3, '{"baseModel":"SDXL"}'), -- no marker: the scan did not set the flag
      (4, '${marker}'),        -- rescan pending
      (5, '${marker}'),        -- moderation row is another entity type's
      (6, '${marker}'),        -- moderation row is another bounty's
      (7, '${marker}');        -- not asked for
    INSERT INTO "Image" VALUES (20, ${NsfwLevel.X});
    INSERT INTO "ImageConnection" VALUES (20, 'Bounty', 2);
    INSERT INTO "EntityModeration" ("entityType", "entityId", "status", "nsfwLevel", "result") VALUES
      ('Bounty', 1, 'Succeeded', ${NsfwLevel.R}, ${v1}),
      ('Bounty', 2, 'Succeeded', ${NsfwLevel.R}, ${v1}),
      ('Bounty', 3, 'Succeeded', ${NsfwLevel.R}, ${v1}),
      ('Bounty', 4, 'Pending', ${NsfwLevel.R}, ${v1}),
      ('Article', 5, 'Succeeded', ${NsfwLevel.R}, ${v1}),
      ('Bounty', 60, 'Succeeded', ${NsfwLevel.R}, ${v1}),
      ('Bounty', 7, 'Succeeded', ${NsfwLevel.R}, ${v1});
  `);
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const q = Prisma.sql(strings, ...(values as never[]));
    return pg.db.query(q.text, q.values as unknown[]).then((r) => r.rows);
  }) as never);
});
afterAll(() => pg.db?.close());

describe('getTextRatedBountyLevels on real rows', () => {
  it('rates only a scan-set flag with a settled verdict on its own moderation row', async () => {
    const levels = await getTextRatedBountyLevels([1, 2, 3, 4, 5, 6]);
    expect(Object.fromEntries(levels)).toEqual({ 1: NsfwLevel.R, 2: NsfwLevel.X });
  });
});
