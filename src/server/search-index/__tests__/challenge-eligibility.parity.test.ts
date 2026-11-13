import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { CHALLENGE_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/challenges/source';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  challengeScanGates,
  challengeSemanticEligibleWhere,
} from '~/server/services/challenge-visibility.sql';

const SCHEMA = `
  CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled');
  CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
  CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "Image" (id int PRIMARY KEY, poi boolean, ingestion "ImageIngestionStatus" NOT NULL);
  CREATE TABLE "Challenge" (
    id int PRIMARY KEY, status "ChallengeStatus" NOT NULL, source "ChallengeSource" NOT NULL,
    ingestion "ChallengeIngestionStatus" NOT NULL, "coverImageId" int
  );
`;

type Over = {
  status?: string;
  source?: string;
  ingestion?: string;
  /** The cover's (poi, ingestion) row, or false for no cover. */
  cover?: false | string;
};

/** One challenge; its cover image has the same id. */
const challenge = (id: number, name: string, include: boolean, over: Over = {}): ParityRow => {
  const cover = over.cover ?? `false, 'Scanned'`;
  const sql = [
    ...(cover === false ? [] : [`INSERT INTO "Image" VALUES (${id}, ${cover})`]),
    `INSERT INTO "Challenge" VALUES (${id}, '${over.status ?? 'Active'}',
      '${over.source ?? 'User'}', '${over.ingestion ?? 'Scanned'}',
      ${cover === false ? 'NULL' : id})`,
  ];
  return { id, name, include, insert: sql.join(';\n') };
};

// The event-engine's copy, which decides which challenges get a point.
const COPY = `SELECT c.id FROM "Challenge" c WHERE ${CHALLENGE_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    challenge(1, 'eligible', true),
    challenge(2, 'scanned', false, { ingestion: 'Pending' }),
    // A System challenge, so the user cover-scan clause can't exclude it too.
    challenge(3, 'cover', false, { source: 'System', cover: false }),
    challenge(4, 'coverNotPoi', false, { cover: `true, 'Scanned'` }),
    challenge(5, 'userCoverScanned', false, { cover: `false, 'Pending'` }),
    challenge(6, 'notCancelled', false, { status: 'Cancelled' }),
    challenge(7, 'blocked', false, { ingestion: 'Blocked' }),
    // System and Mod covers are trusted: an unscanned one leaves the challenge eligible.
    challenge(8, 'systemCoverUnscanned', true, { source: 'System', cover: `false, 'Pending'` }),
    challenge(9, 'modCoverUnscanned', true, { source: 'Mod', cover: `false, 'Pending'` }),
    // poi unset is not a real person.
    challenge(10, 'poiNull', true, { cover: `NULL, 'Scanned'` }),
    // Ended and upcoming challenges stay searchable; the caller filters status.
    challenge(11, 'completed', true, { status: 'Completed' }),
    challenge(12, 'scheduled', true, { status: 'Scheduled' }),
  ],
  clauses: ['scanned', 'cover', 'coverNotPoi', 'userCoverScanned', 'notCancelled'],
  site: async (prisma) =>
    (
      await prisma.$queryRaw<{ id: number }[]>`
        SELECT c.id FROM "Challenge" c
        WHERE ${Prisma.join(challengeSemanticEligibleWhere, ' AND ')}`
    ).map((r) => r.id),
  copy: COPY,
};

describe('challenge semantic search eligibility', () => {
  it('the event-engine keeps exactly the challenges the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });

  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(`\n  AND c.status <> 'Cancelled'`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['notCancelled'] });
  });
});

// The feed's own view of the same gates: a creator still sees their pending challenges, and only
// their own. The parity test above covers the viewer-less form the index keeps.
describe("the feed's scan gates for a viewer", () => {
  const CREATOR = 7;
  const owned = (
    id: number,
    owner: number,
    over: { ingestion?: string; cover?: false | string }
  ) => {
    const cover = over.cover ?? `false, 'Scanned'`;
    return [
      ...(cover === false ? [] : [`INSERT INTO "Image" VALUES (${id}, ${cover})`]),
      `INSERT INTO "Challenge" VALUES (${id}, 'Active', 'User', '${over.ingestion ?? 'Scanned'}',
        ${cover === false ? 'NULL' : id}, ${owner})`,
    ].join(';\n');
  };
  const rows = {
    ownPending: owned(1, CREATOR, { ingestion: 'Pending' }),
    ownPoiCover: owned(2, CREATOR, { cover: `true, 'Scanned'` }),
    ownUnscannedCover: owned(3, CREATOR, { cover: `false, 'Pending'` }),
    ownNoCover: owned(4, CREATOR, { cover: false }),
    otherPending: owned(5, 8, { ingestion: 'Pending' }),
    otherPoiCover: owned(6, 8, { cover: `true, 'Scanned'` }),
    otherUnscannedCover: owned(7, 8, { cover: `false, 'Pending'` }),
  };

  it('lets a creator through every gate but the cover itself, for their own challenges only', async () => {
    const harness = await startPglitePrisma(
      SCHEMA.replace(`"coverImageId" int\n`, `"coverImageId" int, "createdById" int\n`)
    );
    try {
      for (const sql of Object.values(rows)) await harness.pg.exec(sql);
      const visible = async (viewerId?: number) =>
        (
          await harness.prisma.$queryRaw<{ id: number }[]>`
            SELECT c.id FROM "Challenge" c
            WHERE ${Prisma.join(challengeScanGates(viewerId), ' AND ')} ORDER BY c.id`
        ).map((r) => r.id);
      expect(await visible(CREATOR)).toEqual([1, 2, 3]);
      expect(await visible()).toEqual([]);
    } finally {
      await harness.stop();
    }
  });
});
