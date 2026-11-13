import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerHeldSql } from '~/server/services/legal-hold.service';

/**
 * The delete triggers keep an owner's content while any hold on the account stands, not only a hold
 * marker, and what they kept stays until no hold remains. Runs the real migrations on PGlite; each
 * case runs in a transaction that is rolled back.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');

// One owner per hold, each held by that hold alone.
const MARKER = 1; // an active manual marker
const PENDING = 2; // named on an unsent report
const SECONDARY = 3; // the secondary user of an unsent report
const SENT_OLD = 4; // named on a report sent over a year ago, not archived (its marker has expired)
const REVIEW = 5; // an image awaiting review
const BLOCKED = 6; // a blocked image no sent report lists
const LISTED = 7; // an image listed in an unsent report that names someone else
const PLACEHOLDER = -1;
// Not held.
const SENT_OLD_ARCHIVED = 8; // report sent over a year ago and archived; its blocked image listed in it
const PLAIN = 9;
const EXPIRED_MARKER = 10; // a manual marker past its release date
// Marker and an unsent report together.
const MARKER_AND_REPORT = 11;
// A report's year from sending, alone: each report is archived, so only its send date decides.
const SENT_RECENT_ARCHIVED = 12; // named on a report sent 30 days ago; its marker released
const LISTED_RECENT_ARCHIVED = 14; // an image listed in a report sent 30 days ago (no marker: names no one)
const SENT_13M_ARCHIVED = 13; // named on a report sent 13 months ago
const LISTED_13M_ARCHIVED = 15; // an image listed in a report sent 13 months ago

const HELD = [
  SENT_RECENT_ARCHIVED,
  LISTED_RECENT_ARCHIVED,
  MARKER,
  PENDING,
  SECONDARY,
  SENT_OLD,
  REVIEW,
  BLOCKED,
  LISTED,
  PLACEHOLDER,
  MARKER_AND_REPORT,
];
const UNHELD = [SENT_OLD_ARCHIVED, PLAIN, EXPIRED_MARKER, SENT_13M_ARCHIVED, LISTED_13M_ARCHIVED];
const OWNERS = [...HELD, ...UNHELD];

// Every owner has a live image in a post; ids are offset from the owner's.
const liveImage = (uid: number) => 1000 + uid;
const postOf = (uid: number) => 2000 + uid;
// The image that holds its owner (or, for SENT_OLD_ARCHIVED, the one that would).
const holdImage = (uid: number) => 3000 + uid;

const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
`;

const FIXTURE = `
  INSERT INTO "Post" (id, "userId") SELECT 2000 + u, u FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
  INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel")
    SELECT 1000 + u, u, 2000 + u, 4 FROM unnest(ARRAY[${OWNERS.join(',')}]) u;

  INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKER}, 'manual', 'test');
  INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseAt")
    VALUES (${EXPIRED_MARKER}, 'manual', 'test', now() - interval '1 day');
  INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKER_AND_REPORT}, 'manual', 'test');

  INSERT INTO "Image" (id, "userId", "needsReview") VALUES (${holdImage(
    REVIEW
  )}, ${REVIEW}, 'csam');
  INSERT INTO "Image" (id, "userId", ingestion, "blockedFor") VALUES
    (${holdImage(BLOCKED)}, ${BLOCKED}, 'Blocked', 'CSAM'),
    (${holdImage(SENT_OLD_ARCHIVED)}, ${SENT_OLD_ARCHIVED}, 'Blocked', 'CSAM'),
    (${holdImage(LISTED)}, ${LISTED}, 'Blocked', 'moderated'),
    (${holdImage(LISTED_RECENT_ARCHIVED)}, ${LISTED_RECENT_ARCHIVED}, 'Blocked', 'moderated'),
    (${holdImage(LISTED_13M_ARCHIVED)}, ${LISTED_13M_ARCHIVED}, 'Blocked', 'moderated');

  INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images, details) VALUES
    (${PENDING}, NULL, NULL, '[]', '{}'),
    (NULL, NULL, NULL, '[]', '{"secondaryUserId": "${SECONDARY}"}'),
    (${SENT_OLD}, now() - interval '2 years', NULL, '[]', '{}'),
    (${SENT_OLD_ARCHIVED}, now() - interval '2 years', now() - interval '1 year',
      '[{"id": ${holdImage(SENT_OLD_ARCHIVED)}}]', '{}'),
    (NULL, NULL, NULL, '[{"id": ${holdImage(LISTED)}}]', '{}'),
    (${MARKER_AND_REPORT}, NULL, NULL, '[]', '{}'),
    (${SENT_RECENT_ARCHIVED}, now() - interval '30 days', now(), '[]', '{}'),
    (${SENT_13M_ARCHIVED}, now() - interval '13 months', now(), '[]', '{}'),
    (NULL, now() - interval '30 days', now(), '[{"id": ${holdImage(
      LISTED_RECENT_ARCHIVED
    )}}]', '{}'),
    (NULL, now() - interval '13 months', now(), '[{"id": ${holdImage(
      LISTED_13M_ARCHIVED
    )}}]', '{}');
  -- The sent report gave its subject a year-long marker; released, only the report's own year holds.
  UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'test'
    WHERE "userId" = ${SENT_RECENT_ARCHIVED};
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(migration('20261019220000_evidence_hold'));
  await db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
  await db.exec(migration('20261227150000_evidence_hold_owner_held'));
  await db.exec(FIXTURE);
});

beforeEach(async () => {
  await db.exec('BEGIN');
});

afterEach(async () => {
  await db.exec('ROLLBACK');
});

async function heldBy(fn: string, uid: number) {
  const { rows } = await db.query<{ held: boolean }>(`SELECT ${fn}($1::int) AS held`, [uid]);
  return rows[0].held;
}

async function imageRow(id: number) {
  const { rows } = await db.query<{
    ingestion: string;
    blockedFor: string | null;
    nsfwLevel: number;
    postId: number | null;
  }>(`SELECT ingestion, "blockedFor", "nsfwLevel", "postId" FROM "Image" WHERE id = $1`, [id]);
  return rows[0];
}

const count = async (table: string, where: string) =>
  Number(
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`))
      .rows[0].n
  );

const keptImages = (uid: number) => count('EvidenceHoldImage', `"userId" = ${uid}`);
const keptPosts = (uid: number) => count('EvidenceHoldPost', `"userId" = ${uid}`);

describe('evidence_hold_owner_held', () => {
  it('answers what ownerHeldSql answers, for every owner', async () => {
    const app = ownerHeldSql(Prisma.raw('u.id'));
    expect(app.values).toEqual([]);
    const { rows } = await db.query<{ id: number; fn: boolean; app: boolean }>(
      `SELECT u.id, evidence_hold_owner_held(u.id) AS fn, ${app.text} AS app
       FROM unnest($1::int[]) u(id) ORDER BY u.id`,
      [OWNERS]
    );
    expect(rows.filter((r) => r.fn !== r.app)).toEqual([]);
    // Both sides are pinned, so a function that always says held (or never) fails here too.
    expect(rows.filter((r) => r.fn).map((r) => r.id)).toEqual([...HELD].sort((a, b) => a - b));
  });

  it('reads a hold placed after the first check', async () => {
    expect(await heldBy('evidence_hold_owner_held', PLAIN)).toBe(false);
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${PLAIN})`);
    expect(await heldBy('evidence_hold_owner_held', PLAIN)).toBe(true);
  });
});

describe('deleting a held owner’s image', () => {
  it.each(HELD)(
    'owner %i: the row stays, blocked and out of its post, and is recorded',
    async (uid) => {
      const { affectedRows } = await db.query(`DELETE FROM "Image" WHERE id = $1`, [
        liveImage(uid),
      ]);
      expect(affectedRows).toBe(0);
      expect(await imageRow(liveImage(uid))).toEqual({
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
        postId: null,
      });
      expect(
        await count(
          'EvidenceHoldImage',
          `"imageId" = ${liveImage(uid)} AND "postId" = ${postOf(uid)}`
        )
      ).toBe(1);
    }
  );

  it.each(UNHELD)(
    'owner %i (not held): the row is deleted and nothing is recorded',
    async (uid) => {
      const { affectedRows } = await db.query(`DELETE FROM "Image" WHERE id = $1`, [
        liveImage(uid),
      ]);
      expect(affectedRows).toBe(1);
      expect(await imageRow(liveImage(uid))).toBeUndefined();
      expect(await keptImages(uid)).toBe(0);
    }
  );
});

describe('deleting a held owner’s post', () => {
  it.each(HELD)('owner %i: the post is copied before it goes', async (uid) => {
    const { affectedRows } = await db.query(`DELETE FROM "Post" WHERE id = $1`, [postOf(uid)]);
    expect(affectedRows).toBe(1);
    expect(await count('EvidenceHoldPost', `"postId" = ${postOf(uid)}`)).toBe(1);
  });

  it.each(UNHELD)('owner %i (not held): nothing is copied', async (uid) => {
    await db.query(`DELETE FROM "Post" WHERE id = $1`, [postOf(uid)]);
    expect(await keptPosts(uid)).toBe(0);
  });
});

describe('what a hold kept, once its owner has no marker', () => {
  async function keepBoth(uid: number) {
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [liveImage(uid)]);
    await db.query(`DELETE FROM "Post" WHERE id = $1`, [postOf(uid)]);
    expect([await keptImages(uid), await keptPosts(uid)]).toEqual([1, 1]);
  }

  it('survives the sweep while an unsent report holds, and goes once it is sent, aged and archived', async () => {
    await keepBoth(PENDING);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(PENDING), await keptPosts(PENDING)]).toEqual([1, 1]);

    await db.exec(`
      UPDATE "CsamReport" SET "reportSentAt" = now() - interval '2 years', "archivedAt" = now()
      WHERE "userId" = ${PENDING}
    `);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(PENDING), await keptPosts(PENDING)]).toEqual([0, 0]);
  });

  it('survives the sweep after its year-long marker has lapsed, while the report is unarchived', async () => {
    // The sent report's marker ended a year after sending; only the report still holds.
    expect(await count('EvidenceHeldUser', `"userId" = ${SENT_OLD}`)).toBe(0);
    await keepBoth(SENT_OLD);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(SENT_OLD), await keptPosts(SENT_OLD)]).toEqual([1, 1]);

    await db.exec(`UPDATE "CsamReport" SET "archivedAt" = now() WHERE "userId" = ${SENT_OLD}`);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(SENT_OLD), await keptPosts(SENT_OLD)]).toEqual([0, 0]);
  });

  it('survives the sweep while an image awaits review, and goes once the review is done', async () => {
    await keepBoth(REVIEW);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(REVIEW), await keptPosts(REVIEW)]).toEqual([1, 1]);

    await db.exec(`UPDATE "Image" SET "needsReview" = NULL WHERE id = ${holdImage(REVIEW)}`);
    await db.exec(`SELECT evidence_hold_purge_unheld()`);
    expect([await keptImages(REVIEW), await keptPosts(REVIEW)]).toEqual([0, 0]);
  });

  it('cannot be deleted directly while a report holds its owner', async () => {
    await keepBoth(PENDING);
    await expect(
      db.exec(`DELETE FROM "EvidenceHoldImage" WHERE "userId" = ${PENDING}`)
    ).rejects.toThrow(/cannot be deleted while its owner is held/);
  });
});

describe('releasing a marker', () => {
  const release = (uid: number) =>
    db.exec(`
      UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'test'
      WHERE "userId" = ${uid}
    `);

  it('purges nothing while a report still holds the owner', async () => {
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [liveImage(MARKER_AND_REPORT)]);
    await db.query(`DELETE FROM "Post" WHERE id = $1`, [postOf(MARKER_AND_REPORT)]);
    await release(MARKER_AND_REPORT);
    expect([await keptImages(MARKER_AND_REPORT), await keptPosts(MARKER_AND_REPORT)]).toEqual([
      1, 1,
    ]);
  });

  it('purges at once when it was the only hold', async () => {
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [liveImage(MARKER)]);
    await db.query(`DELETE FROM "Post" WHERE id = $1`, [postOf(MARKER)]);
    await release(MARKER);
    expect([await keptImages(MARKER), await keptPosts(MARKER)]).toEqual([0, 0]);
  });
});

describe('the delete triggers’ per-owner memo', () => {
  const memoName = (uid: number) => `evidence_hold.owner_${uid}`;
  // Sets the memo and reads it back through the function in one statement.
  const seededThenRead = (uid: number, memo: string) =>
    db
      .query<{ held: boolean }>(
        `SELECT set_config($1, ${memo}, true) AS seeded, evidence_hold_owner_held_memo($2::int) AS held`,
        [memoName(uid), uid]
      )
      .then((r) => r.rows[0].held);
  const fresh = (answer: 't' | 'f') =>
    `statement_timestamp()::text || '|' || extract(epoch FROM clock_timestamp())::text || '|${answer}'`;

  it('checks live on an empty memo: a held owner is held on the first row', async () => {
    expect(await heldBy('evidence_hold_owner_held_memo', PENDING)).toBe(true);
    expect(await heldBy('evidence_hold_owner_held_memo', PLAIN)).toBe(false);
    expect(await heldBy('evidence_hold_owner_held_memo', PLACEHOLDER)).toBe(true);
  });

  it('reuses a fresh answer within the statement', async () => {
    // A held owner with a fresh "not held" memo reads not held: the memo, not a live check.
    expect(await seededThenRead(PENDING, fresh('f'))).toBe(false);
  });

  it('checks live once the answer is over 5 seconds old', async () => {
    const stale = `statement_timestamp()::text || '|' || (extract(epoch FROM clock_timestamp()) - 6)::text || '|f'`;
    expect(await seededThenRead(PENDING, stale)).toBe(true);
  });

  it('checks live on an answer stamped in the future', async () => {
    const ahead = `statement_timestamp()::text || '|' || (extract(epoch FROM clock_timestamp()) + 3600)::text || '|f'`;
    expect(await seededThenRead(PENDING, ahead)).toBe(true);
  });

  it('checks live on a memo it cannot read', async () => {
    const now = `statement_timestamp()::text || '|' || extract(epoch FROM clock_timestamp())::text`;
    for (const garbage of [
      `'garbage'`,
      `'a|b|c'`,
      `statement_timestamp()::text || '|1e99|f'`,
      `${now} || '|x'`,
      `${now} || '|f|f'`,
      `''`,
    ]) {
      expect(await seededThenRead(PENDING, garbage)).toBe(true);
    }
  });

  it('checks live in the next statement of the same transaction', async () => {
    expect(await heldBy('evidence_hold_owner_held_memo', PLAIN)).toBe(false);
    await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${PLAIN})`);
    // Well inside the 5 seconds, so only the statement tells the two apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { affectedRows } = await db.query(`DELETE FROM "Image" WHERE id = $1`, [
      liveImage(PLAIN),
    ]);
    expect(affectedRows).toBe(0);
    expect(await keptImages(PLAIN)).toBe(1);
  });

  it('holds every row of a held owner deleted in one statement', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "userId") SELECT 5000 + g, ${PENDING} FROM generate_series(1, 50) g
    `);
    const { affectedRows } = await db.query(`DELETE FROM "Image" WHERE "userId" = $1`, [PENDING]);
    expect(affectedRows).toBe(0);
    expect(await keptImages(PENDING)).toBe(51);
  });
});

describe('changing the owner', () => {
  const NEW_OWNER = 77;
  const move = (table: string, id: number) =>
    db.query(`UPDATE "${table}" SET "userId" = $1 WHERE id = $2`, [NEW_OWNER, id]);

  it.each([
    ['Image', liveImage(PENDING)],
    ['Post', postOf(PENDING)],
    ['Model', 4000 + PENDING],
  ])('of a held owner’s %s with no marker is refused', async (table, id) => {
    await db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${4000 + PENDING}, ${PENDING})`);
    await expect(move(table, id)).rejects.toThrow(/cannot change owner/);
  });

  it('of an unheld owner’s model goes ahead', async () => {
    await db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${4000 + PLAIN}, ${PLAIN})`);
    expect((await move('Model', 4000 + PLAIN)).affectedRows).toBe(1);
  });

  // Restoring an account hands its models back from the placeholder owner.
  it('of a placeholder-owned model goes ahead, as before', async () => {
    await db.exec(`INSERT INTO "Model" (id, "userId") VALUES (3999, ${PLACEHOLDER})`);
    expect((await move('Model', 3999)).affectedRows).toBe(1);
  });
});
