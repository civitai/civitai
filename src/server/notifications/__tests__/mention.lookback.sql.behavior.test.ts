import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  liveCommentCreatedOrEditedSince,
  modelDescriptionPublishedOrEditedSince,
} from '~/server/notifications/mention.notifications';

/**
 * The comment and model-description mention reads look a little behind the job's cursor: a row
 * stamped just before a run can first be visible on the replica after it.
 */
const LAST_SENT = new Date(Date.now() - 60 * 60_000).toISOString();
const before = (interval: string) => `'${LAST_SENT}'::timestamp - interval '${interval}'`;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TimeZone = 'UTC';
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "createdAt" timestamp(3) NOT NULL, "updatedAt" timestamp(3) NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, hidden boolean
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "publishedAt" timestamp(3), "updatedAt" timestamp(3) NOT NULL);
  `);
});
afterAll(() => db.close());
beforeEach(() => db.exec(`TRUNCATE "CommentV3", "Model"`));

const comments = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "CommentV3" c WHERE ${liveCommentCreatedOrEditedSince(LAST_SENT)} ORDER BY id`
    )
  ).rows.map((r) => r.id);
const models = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT id FROM "Model" m WHERE ${modelDescriptionPublishedOrEditedSince(
        LAST_SENT
      )} ORDER BY id`
    )
  ).rows.map((r) => r.id);

describe('comment mentions', () => {
  it('a comment created just before the last run is still read', async () => {
    await db.exec(
      `INSERT INTO "CommentV3" VALUES (1, ${before('30 seconds')}, ${before('30 seconds')})`
    );
    expect(await comments()).toEqual([1]);
  });

  it('an edit made just before the last run is still read', async () => {
    await db.exec(
      `INSERT INTO "CommentV3" VALUES (1, ${before('2 hours')}, ${before('30 seconds')})`
    );
    expect(await comments()).toEqual([1]);
  });

  it('a comment untouched since well before the last run is not re-read', async () => {
    await db.exec(
      `INSERT INTO "CommentV3" VALUES (1, ${before('10 minutes')}, ${before('10 minutes')})`
    );
    expect(await comments()).toEqual([]);
  });

  it('an edit to a comment older than a day still notifies nobody', async () => {
    await db.exec(
      `INSERT INTO "CommentV3" VALUES (1, ${before('2 days')}, ${before('30 seconds')})`
    );
    expect(await comments()).toEqual([]);
  });
});

describe('model description mentions', () => {
  it('a model published just before the last run is still read', async () => {
    await db.exec(
      `INSERT INTO "Model" VALUES (1, ${before('30 seconds')}, ${before('30 seconds')})`
    );
    expect(await models()).toEqual([1]);
  });

  it('a description edited just before the last run is still read', async () => {
    await db.exec(`INSERT INTO "Model" VALUES (1, ${before('30 days')}, ${before('30 seconds')})`);
    expect(await models()).toEqual([1]);
  });

  it('a model untouched since well before the last run is not re-read', async () => {
    await db.exec(
      `INSERT INTO "Model" VALUES (1, ${before('10 minutes')}, ${before('10 minutes')})`
    );
    expect(await models()).toEqual([]);
  });
});
