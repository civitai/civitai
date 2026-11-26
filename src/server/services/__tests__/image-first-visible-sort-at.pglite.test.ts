import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  imageBlockedForConditions,
  imageNotRestrictedSql,
  imageReviewedSql,
  minorMatureImageVisibleSql,
} from '~/server/common/image-visibility';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

vi.setConfig({ hookTimeout: 60_000 });

const TRIGGERS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql'
);

let pg: PGlite;

const DAY = 24 * 60 * 60 * 1000;
const POST_RECENT = 1;
const POST_OLD = 2;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
    CREATE TABLE "Image" (
      id serial PRIMARY KEY,
      "postId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
      "scannedAt" timestamp(3),
      "sortAt" timestamp(3),
      "firstVisibleAt" timestamp(3),
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text,
      "blockedFor" text,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "modelRestricted" boolean NOT NULL DEFAULT false,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      metadata jsonb NOT NULL DEFAULT '{}',
      "scanJobs" jsonb
    );
    INSERT INTO "Post" VALUES
      (${POST_RECENT}, now() - interval '2 days'),
      (${POST_OLD}, now() - interval '8 days');
  `);
  // Rows that exist before the triggers are installed: what the migration finds on a live database.
  await pg.exec(`
    INSERT INTO "Image" (id, "postId", "createdAt", "scannedAt", "sortAt", ingestion, "nsfwLevel", "needsReview")
    VALUES
      (1, ${POST_RECENT}, now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'Scanned', 1, NULL),
      (2, ${POST_RECENT}, now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'Scanned', 1, 'poi');
    SELECT setval('"Image_id_seq"', 2);
  `);
  await pg.exec(readFileSync(TRIGGERS, 'utf8'));
});
afterAll(() => pg.close());

const pause = () => new Promise((r) => setTimeout(r, 15));

async function row(id: number) {
  const { rows } = await pg.query<{ sortAt: Date; firstVisibleAt: Date | null }>(
    `SELECT "sortAt", "firstVisibleAt" FROM "Image" WHERE id = $1`,
    [id]
  );
  return rows[0];
}

const now = async () => (await pg.query<{ t: Date }>(`SELECT now()::timestamp(3) AS t`)).rows[0].t;

/** An image uploaded 2 days ago and held by its scan: never served. */
async function insertHeld(postId = POST_RECENT) {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "Image" ("postId", "createdAt", "scannedAt", ingestion, "nsfwLevel", "needsReview")
     VALUES ($1, now() - interval '2 days', now() - interval '2 days', 'Scanned', 1, 'poi')
     RETURNING id`,
    [postId]
  );
  return rows[0].id;
}

/** An image uploaded 2 days ago whose clean scan lands now: served from its scan on. */
async function insertVisible(postId = POST_RECENT) {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "Image" ("postId", "createdAt")
     VALUES ($1, now() - interval '2 days') RETURNING id`,
    [postId]
  );
  const id = rows[0].id;
  await pg.query(
    `UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1, "scannedAt" = now() WHERE id = $1`,
    [id]
  );
  return id;
}

const setReview = (id: number, needsReview: string | null) =>
  pg.query(`UPDATE "Image" SET "needsReview" = $2 WHERE id = $1`, [id, needsReview]);

describe('a held image released by a moderator', () => {
  it('sorts at its release time', async () => {
    const id = await insertHeld();
    const before = await row(id);
    await pause();
    const releasedFrom = await now();
    await setReview(id, null);

    const after = await row(id);
    expect(+after.sortAt).toBeGreaterThanOrEqual(+releasedFrom);
    expect(+after.sortAt).toBeGreaterThan(+before.sortAt + DAY);
  });

  it('moves once across two hold/release cycles, on the first release', async () => {
    const id = await insertHeld();
    await pause();
    await setReview(id, null);
    const first = await row(id);

    await setReview(id, 'poi');
    await pause();
    await setReview(id, null);

    const second = await row(id);
    expect(+first.sortAt).toBeGreaterThan(Date.now() - DAY);
    expect(+second.sortAt).toBe(+first.sortAt);
  });

  it('keeps its publish-time sortAt when released more than 7 days after publish', async () => {
    const id = await insertHeld(POST_OLD);
    const before = await row(id);
    await pause();
    await setReview(id, null);

    expect(+(await row(id)).sortAt).toBe(+before.sortAt);
  });

  it('keeps the release time when its post is rescheduled inside the cap', async () => {
    const id = await insertHeld();
    await pause();
    await setReview(id, null);
    const released = await row(id);

    await pg.query(`UPDATE "Post" SET "publishedAt" = now() - interval '3 days' WHERE id = $1`, [
      POST_RECENT,
    ]);

    expect(+(await row(id)).sortAt).toBe(+released.sortAt);
    await pg.query(`UPDATE "Post" SET "publishedAt" = now() - interval '2 days' WHERE id = $1`, [
      POST_RECENT,
    ]);
  });
});

describe('an image that was already served', () => {
  it('never held: sorts at GREATEST(publish, scan, create), as before', async () => {
    const id = await insertVisible();
    const { rows } = await pg.query<{ expected: Date }>(
      `SELECT GREATEST(p."publishedAt", i."scannedAt", i."createdAt") AS expected
       FROM "Image" i JOIN "Post" p ON p.id = i."postId" WHERE i.id = $1`,
      [id]
    );
    expect(+(await row(id)).sortAt).toBe(+rows[0].expected);
  });

  it.each([
    ['a report hold', `"needsReview" = 'reported'`, `"needsReview" = NULL`],
    ['a ToS removal', `"tosViolation" = true`, `"tosViolation" = false`],
    ['a block', `"blockedFor" = 'Moderated'`, `"blockedFor" = NULL`],
  ])('does not move when %s is lifted', async (_, hide, unhide) => {
    const id = await insertVisible();
    const before = await row(id);
    await pg.query(`UPDATE "Image" SET ${hide} WHERE id = $1`, [id]);
    await pause();
    await pg.query(`UPDATE "Image" SET ${unhide} WHERE id = $1`, [id]);

    expect(+(await row(id)).sortAt).toBe(+before.sortAt);
  });

  it('does not rise when a released image moves to an older post', async () => {
    const id = await insertHeld();
    await pause();
    await setReview(id, null);
    const released = await row(id);
    await pg.query(`UPDATE "Image" SET "postId" = $2 WHERE id = $1`, [id, POST_OLD]);

    const moved = await row(id);
    expect(+moved.sortAt).toBeLessThanOrEqual(+released.sortAt);
    expect(moved.firstVisibleAt).toEqual(released.firstVisibleAt);
  });

  it('ignores a client write to firstVisibleAt', async () => {
    const id = await insertVisible();
    const before = await row(id);
    await pg.query(`UPDATE "Image" SET "firstVisibleAt" = now() WHERE id = $1`, [id]);

    expect(await row(id)).toEqual(before);
  });
});

describe('rows inserted before the migration', () => {
  it('do not move on hide then unhide', async () => {
    const before = await row(1);
    await setReview(1, 'reported');
    await pause();
    await setReview(1, null);

    expect(+(await row(1)).sortAt).toBe(+before.sortAt);
  });

  it('do not move when a hold from before the migration is released', async () => {
    const before = await row(2);
    await pause();
    await setReview(2, null);

    expect(+(await row(2)).sortAt).toBe(+before.sortAt);
  });
});

describe('the trigger’s public-row test', () => {
  // The public feed's row-level gates for a viewer who is neither owner nor moderator. The four
  // helpers are the ones getAllImages calls; the first three conditions are inline there and are
  // restated here, so a change to one of those must be made here too.
  const tsPublic = Prisma.sql`(
    i."needsReview" IS NULL
    AND i."acceptableMinor" = FALSE
    AND (i."nsfwLevel" & ${allBrowsingLevelsFlag}) != 0
    AND ${imageReviewedSql()}
    AND ${Prisma.join(imageBlockedForConditions({}), ' AND ')}
    AND ${minorMatureImageVisibleSql({})}
    AND ${imageNotRestrictedSql({ alias: 'i' })}
  )`;

  it('agrees with the feed gates on every combination of the columns they read', async () => {
    const values: string[] = [];
    for (const ingestion of Object.values(ImageIngestionStatus))
      for (const locked of [false, true])
        for (const level of [0, 1, 4, 16, 32])
          for (const review of ['NULL', `'poi'`])
            for (const blocked of ['NULL', `'AiNotVerified'`])
              for (const tos of [false, true])
                for (const acceptable of [false, true])
                  for (const [minor, restricted] of [
                    [false, false],
                    [true, false],
                    [false, true],
                    [true, true],
                  ])
                    for (const reason of [
                      `'{}'`,
                      `'{"nsfwLevelReason": "${KNIGHTS_VOTE_NSFW_LEVEL_REASON}"}'`,
                      `'{"nsfwLevelReason": "Moderator"}'`,
                    ])
                      for (const jobs of [
                        'NULL',
                        `'{"error": {"failureClass": "permanent"}}'`,
                        `'{"lastFailure": {"failureClass": "permanent"}}'`,
                        `'{"permanentFailure": true}'`,
                        `'{"permanentFailure": false}'`,
                        `'{"error": {"failureClass": "transient"}}'`,
                      ])
                        values.push(
                          `('${ingestion}', ${locked}, ${level}, ${review}, ${blocked}, ${tos}, ${acceptable}, ${minor}, ${restricted}, ${reason}::jsonb, ${jobs}::jsonb)`
                        );
    await pg.exec(`
      CREATE TABLE parity (LIKE "Image" INCLUDING DEFAULTS);
      INSERT INTO parity (ingestion, "nsfwLevelLocked", "nsfwLevel", "needsReview", "blockedFor",
        "tosViolation", "acceptableMinor", minor, "modelRestricted", metadata, "scanJobs")
      VALUES ${values.join(',\n')};
    `);
    const q = Prisma.sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${tsPublic})::int AS public,
        count(*) FILTER (WHERE image_row_public(i.ingestion, i."needsReview", i."blockedFor",
          i."acceptableMinor", i."nsfwLevel", i."nsfwLevelLocked", i.metadata, i."scanJobs",
          i.minor, i."modelRestricted") IS DISTINCT FROM ${tsPublic})::int AS mismatched
      FROM parity i`;
    const { rows } = await pg.query<{ total: number; public: number; mismatched: number }>(
      q.text,
      q.values
    );
    expect(rows[0].total).toBe(values.length);
    // Both outcomes occur, so the comparison cannot pass on a constant.
    expect(rows[0].public).toBeGreaterThan(0);
    expect(rows[0].public).toBeLessThan(rows[0].total);
    expect(rows[0].mismatched).toBe(0);
  });
});
