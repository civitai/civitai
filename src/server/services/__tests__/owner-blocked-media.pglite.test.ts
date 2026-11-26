import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { imageBlockedForConditions, ownerMediaSql } from '~/server/common/image-visibility';
import {
  entityImageVisibilityConditions,
  notReportListedSql,
} from '~/server/services/image-visibility.service';

/**
 * A block refuses an image's media to its owner too, on the reads that serve media, run against
 * PGlite. A Blocked rating with no block, and the metadata hold, stay with the owner. The metadata
 * hold opens nothing else: combined with a csam hold, a Blocked rating or a CsamReport listing, it
 * answers as it did before the rule.
 */

const OWNER = 5;
const STRANGER = 6;
const { Blocked } = NsfwLevel;

type Row = {
  ingestion?: string;
  blockedFor?: string | null;
  nsfwLevel?: number;
  needsReview?: string | null;
  reportListed?: boolean;
};
const ROWS: Record<string, Row & { id: number; owner: boolean }> = {
  clean: { id: 1, owner: true },
  'moderator-blocked': {
    id: 2,
    owner: false,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.Moderated,
    nsfwLevel: Blocked,
  },
  'scan-blocked, no reason': { id: 3, owner: false, ingestion: 'Blocked' },
  'CSAM-blocked': {
    id: 4,
    owner: false,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.CSAM,
    nsfwLevel: Blocked,
  },
  'rated Blocked, no block': { id: 5, owner: true, nsfwLevel: Blocked },
  'held for its metadata': {
    id: 6,
    owner: true,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.AiNotVerified,
  },
  'held for its metadata and for csam review': {
    id: 7,
    owner: true,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.AiNotVerified,
    needsReview: 'csam',
  },
  'held for its metadata and rated Blocked': {
    id: 8,
    owner: true,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.AiNotVerified,
    nsfwLevel: Blocked,
  },
  'held for its metadata and listed on a CsamReport': {
    id: 9,
    owner: false,
    ingestion: 'Blocked',
    blockedFor: BlockedReason.AiNotVerified,
    reportListed: true,
  },
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "blockedFor" text,
      "modelRestricted" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, images jsonb);
  `);
  for (const row of Object.values(ROWS)) {
    await db.query(
      `INSERT INTO "Image" (id, ingestion, "blockedFor", "nsfwLevel", "needsReview")
       VALUES ($1, $2::"ImageIngestionStatus", $3, $4, $5)`,
      [
        row.id,
        row.ingestion ?? 'Scanned',
        row.blockedFor ?? null,
        row.nsfwLevel ?? 1,
        row.needsReview ?? null,
      ]
    );
    if (row.reportListed)
      await db.query(`INSERT INTO "CsamReport" (images) VALUES ($1::jsonb)`, [
        JSON.stringify([{ id: row.id }]),
      ]);
  }
});
afterAll(() => db.close());

const ids = async (where: Prisma.Sql[]) => {
  const sql = Prisma.sql`SELECT i.id FROM "Image" i WHERE ${Prisma.join(
    where,
    ' AND '
  )} ORDER BY i.id`;
  return (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);
};

// The bounty image read: the entity rules and the CsamReport exclusion.
const bountyImages = (userId?: number) =>
  ids([...entityImageVisibilityConditions({ userId }), notReportListedSql()]);
// The image feed's block terms (`getAllImagesUncaptured` and the post image lists).
const feedImages = (userId?: number) =>
  ids([
    Prisma.sql`(i.ingestion != 'Blocked' OR i."userId" = ${userId ?? null})`,
    ...imageBlockedForConditions({ userId }),
    ownerMediaSql(userId),
  ]);

describe.each([
  ['a bounty image read', bountyImages],
  ['the image feed', feedImages],
])('%s', (_, read) => {
  it.each(Object.entries(ROWS))(
    'serves the owner an image %s only where the rule allows',
    async (_, row) => {
      // The feed has no CsamReport exclusion of its own.
      const expected = row.owner || (read === feedImages && !!row.reportListed);
      expect((await read(OWNER)).includes(row.id)).toBe(expected);
    }
  );

  it('serves a stranger and a signed-out viewer none of the blocked images', async () => {
    for (const viewer of [STRANGER, undefined]) {
      const served = await read(viewer);
      for (const id of [2, 3, 4, 6, 7, 8, 9]) expect(served).not.toContain(id);
    }
  });

  it('serves a moderator every image the CsamReport exclusion leaves', async () => {
    const all = Object.values(ROWS).map((r) => r.id);
    const served =
      read === bountyImages
        ? await ids([
            ...entityImageVisibilityConditions({ isModerator: true }),
            notReportListedSql(),
          ])
        : await ids([...imageBlockedForConditions({ isModerator: true }), Prisma.sql`TRUE`]);
    expect(served).toEqual(read === bountyImages ? all.filter((id) => id !== 9) : all);
  });
});

describe('imageBlockedForConditions for a read that keeps the row', () => {
  it('leaves its owner the blocked row (the image page serves it without media)', async () => {
    expect(
      await ids(imageBlockedForConditions({ userId: OWNER, ownerKeepsBlockedRow: true }))
    ).toEqual(Object.values(ROWS).map((r) => r.id));
  });
});
