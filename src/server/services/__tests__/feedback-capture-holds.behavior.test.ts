import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/image.service', () => ({ deleteImages: vi.fn() }));

import {
  accountHoldSql,
  captureImageKeptSql,
  ownerHeldSql,
} from '~/server/services/legal-hold.service';
import {
  expiredCapturesSql,
  feedbackCaptureDeleteGuard,
  keptCapturesSql,
  summarizeKept,
} from '~/server/jobs/purge-feedback-captures';
import { purgeHoldGuard } from '~/server/jobs/image-ingestion';

/** Page captures are each held on their own state, never as the capture account's content. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
const OTHER = 7;
const OLD = '2020-01-01';
const YOUNG = '2999-01-01';
const CUTOFF = new Date('2026-01-01');

let db: PGlite;
const query = async <T>(sql: Prisma.Sql) => (await db.query<T>(sql.text, sql.values)).rows;
const value = async (sql: Prisma.Sql) =>
  (await query<{ v: unknown }>(Prisma.sql`SELECT ${sql} AS v`))[0].v;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "EvidenceHoldImage" ("imageId" int NOT NULL);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "createdAt" timestamp(3) NOT NULL,
      "needsReview" text, "blockedFor" text, minor boolean NOT NULL DEFAULT false, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned'
    );
  `);
});
afterAll(() => db.close());
beforeEach(() => db.exec(`TRUNCATE "CsamReport", "EvidenceHold", "EvidenceHoldImage", "Image"`));

const seedImage = (
  id: number,
  {
    userId = CAPTURE,
    createdAt = OLD,
    needsReview = null,
    blockedFor = null,
    ingestion = 'Scanned',
  }: {
    userId?: number;
    createdAt?: string;
    needsReview?: string | null;
    blockedFor?: string | null;
    ingestion?: string;
  } = {}
) =>
  db.query(
    `INSERT INTO "Image" (id, "userId", "createdAt", "needsReview", "blockedFor", ingestion)
     VALUES ($1, $2, $3, $4, $5, $6::"ImageIngestionStatus")`,
    [id, userId, createdAt, needsReview, blockedFor, ingestion]
  );

/** The four states that keep a capture, each set on capture `id`. */
const CLAUSES: [string, (id: number) => Promise<unknown>][] = [
  ['under review', (id) => seedImage(id, { needsReview: 'csam' })],
  ['blocked', (id) => seedImage(id, { blockedFor: 'CSAM' })],
  [
    'flagged minor',
    async (id) => {
      await seedImage(id);
      await db.query(`UPDATE "Image" SET minor = true WHERE id = $1`, [id]);
    },
  ],
  [
    'listed on a report',
    async (id) => {
      await seedImage(id);
      await db.query(`INSERT INTO "CsamReport" ("userId", images) VALUES (NULL, $1)`, [
        JSON.stringify([{ id }]),
      ]);
    },
  ],
  [
    'kept by an evidence hold',
    async (id) => {
      await seedImage(id);
      await db.query(`INSERT INTO "EvidenceHoldImage" VALUES ($1)`, [id]);
    },
  ],
];

/** The states the account-hold image legs read (a minor flag is not one of them). */
const ACCOUNT_LEG_CLAUSES = CLAUSES.filter(([label]) =>
  ['under review', 'blocked', 'listed on a report'].includes(label)
);

describe('account holds', () => {
  const held = (userId: number) => value(accountHoldSql(Prisma.sql`${userId}::int`, true));

  it.each(ACCOUNT_LEG_CLAUSES)(
    'a capture %s does not hold the capture account',
    async (_label, seed) => {
      await seed(1);
      expect(await held(CAPTURE)).toBe(false);
      expect(await value(ownerHeldSql(Prisma.sql`${CAPTURE}::int`))).toBe(false);
    }
  );

  it.each(ACCOUNT_LEG_CLAUSES)(
    'an ordinary account with an image %s is still held',
    async (_label, seed) => {
      await seed(1);
      await db.exec(`UPDATE "Image" SET "userId" = ${OTHER}`);
      expect(await held(OTHER)).toBe(true);
    }
  );

  it('a report naming the capture account still holds it', async () => {
    await db.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [CAPTURE]);
    expect(await held(CAPTURE)).toBe(true);
  });
});

describe('captureImageKeptSql', () => {
  const kept = async (id: number) =>
    (
      await query<{ v: boolean }>(
        Prisma.sql`SELECT ${captureImageKeptSql('i')} AS v FROM "Image" i WHERE i.id = ${id}`
      )
    )[0].v;

  it.each(CLAUSES)('keeps a capture %s', async (_label, seed) => {
    await seed(1);
    expect(await kept(1)).toBe(true);
  });

  it('keeps nothing clean, and no other owner’s image', async () => {
    await seedImage(1);
    await seedImage(2, { userId: OTHER, needsReview: 'csam' });
    expect(await kept(1)).toBe(false);
    expect(await kept(2)).toBe(false);
  });
});

describe('the blocked-image purge guard', () => {
  const deletable = async () =>
    (
      await query<{ id: number }>(
        Prisma.sql`SELECT id FROM "Image" WHERE ${purgeHoldGuard({ holdForTrainingCopy: false })}`
      )
    ).map((r) => r.id);

  it.each(CLAUSES)('keeps a blocked capture %s', async (_label, seed) => {
    await seed(1);
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked'`);
    expect(await deletable()).toEqual([]);
  });

  it('purges a blocked capture nothing keeps (control)', async () => {
    await seedImage(1, { ingestion: 'Blocked' });
    expect(await deletable()).toEqual([1]);
  });
});

describe('purge-feedback-captures', () => {
  const expired = async () =>
    (await query<{ id: number }>(expiredCapturesSql(CUTOFF))).map((r) => r.id);
  const guarded = async () =>
    (
      await query<{ id: number }>(
        Prisma.sql`SELECT id FROM "Image" WHERE ${feedbackCaptureDeleteGuard(CUTOFF)}`
      )
    ).map((r) => r.id);

  it('deletes an old clean capture, oldest first', async () => {
    await seedImage(2, { createdAt: '2021-01-01' });
    await seedImage(1, { createdAt: '2020-01-01' });
    expect(await expired()).toEqual([1, 2]);
    expect((await guarded()).sort()).toEqual([1, 2]);
  });

  it('keeps a young capture and every other owner’s images', async () => {
    await seedImage(1, { createdAt: YOUNG });
    await seedImage(2, { userId: OTHER });
    expect(await expired()).toEqual([]);
    expect(await guarded()).toEqual([]);
  });

  it.each(CLAUSES)('keeps an old capture %s, and logs why', async (_label, seed) => {
    await seed(1);
    expect(await expired()).toEqual([]);
    expect(await guarded()).toEqual([]);
    const summary = summarizeKept(await query(keptCapturesSql(CUTOFF)));
    expect(summary.kept).toBe(1);
    expect(summary.keptIds).toEqual([1]);
  });

  it('breaks the kept count down by each state', async () => {
    for (const [i, [, seed]] of CLAUSES.entries()) await seed(i + 1);
    expect(summarizeKept(await query(keptCapturesSql(CUTOFF)))).toMatchObject({
      kept: 5,
      keptReview: 1,
      keptBlocked: 1,
      keptMinor: 1,
      keptReported: 1,
      keptEvidenceHold: 1,
    });
  });

  // The log reads the guard's own legs, so a report list holding a null cannot make it disagree.
  it('logs each state exactly as the guard reads it', async () => {
    await CLAUSES[2][1](1);
    await db.query(
      `INSERT INTO "CsamReport" ("userId", images) VALUES (NULL, '[null, {"id": 9}]')`
    );
    expect(await query(keptCapturesSql(CUTOFF))).toEqual([
      { id: 1, review: false, blocked: false, minor: true, reported: false, evidenceHold: false },
    ]);
  });

  it('keeps every capture while the capture account is marked', async () => {
    await seedImage(1);
    await db.query(`INSERT INTO "EvidenceHold" VALUES ($1)`, [CAPTURE]);
    expect(await guarded()).toEqual([]);
  });
});
