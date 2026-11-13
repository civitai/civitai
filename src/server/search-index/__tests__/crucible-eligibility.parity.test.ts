import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { CRUCIBLE_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/crucibles/source';
import { crucibleSemanticEligibleWhere } from '~/server/services/crucible-visibility.sql';

const SCHEMA = `
  CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
  CREATE TYPE "CrucibleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
    "tosViolation" boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "Crucible" (
    id int PRIMARY KEY, status "CrucibleStatus" NOT NULL,
    ingestion "CrucibleIngestionStatus" NOT NULL, "imageId" int, "takenDownAt" timestamp(3)
  );
`;

type Over = {
  status?: string;
  ingestion?: string;
  takenDownAt?: string;
  /** The cover's ingestion, or false for no cover. */
  cover?: false | string;
  /** The cover's needsReview and tosViolation. */
  review?: string;
};

/** One crucible; its cover image has the same id. */
const crucible = (id: number, name: string, include: boolean, over: Over = {}): ParityRow => {
  const cover = over.cover ?? 'Scanned';
  const sql = [
    ...(cover === false
      ? []
      : [`INSERT INTO "Image" VALUES (${id}, '${cover}', ${over.review ?? 'NULL, false'})`]),
    `INSERT INTO "Crucible" VALUES (${id}, '${over.status ?? 'Active'}',
      '${over.ingestion ?? 'Scanned'}', ${cover === false ? 'NULL' : id},
      ${over.takenDownAt ?? 'NULL'})`,
  ];
  return { id, name, include, insert: sql.join(';\n') };
};

// The event-engine's copy, which decides which crucibles get a point. Both sides join the cover
// as list surfaces do.
const FROM = `FROM "Crucible" c LEFT JOIN "Image" i ON i.id = c."imageId"`;
const COPY = `SELECT c.id ${FROM} WHERE ${CRUCIBLE_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    crucible(1, 'eligible', true),
    crucible(2, 'scanned', false, { ingestion: 'Pending' }),
    crucible(3, 'coverScanned', false, { cover: 'Pending' }),
    crucible(4, 'notCancelled', false, { status: 'Cancelled' }),
    crucible(5, 'notTakenDown', false, { status: 'Completed', takenDownAt: 'now()' }),
    crucible(6, 'noCover', false, { cover: false }),
    crucible(7, 'blocked', false, { ingestion: 'Blocked' }),
    crucible(10, 'coverNotInReview', false, { review: `'minor', false` }),
    crucible(11, 'coverNotTos', false, { review: `NULL, true` }),
    // Upcoming and finished crucibles stay searchable; the caller filters status.
    crucible(8, 'pending', true, { status: 'Pending' }),
    crucible(9, 'completed', true, { status: 'Completed' }),
  ],
  clauses: [
    'scanned',
    'coverScanned',
    'coverNotInReview',
    'coverNotTos',
    'notCancelled',
    'notTakenDown',
  ],
  site: async (prisma) =>
    (
      await prisma.$queryRaw<{ id: number }[]>`
        SELECT c.id FROM "Crucible" c LEFT JOIN "Image" i ON i.id = c."imageId"
        WHERE ${Prisma.join(crucibleSemanticEligibleWhere, ' AND ')}`
    ).map((r) => r.id),
  copy: COPY,
};

describe('crucible semantic search eligibility', () => {
  it('the event-engine keeps exactly the crucibles the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });

  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(` AND c."takenDownAt" IS NULL`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['notTakenDown'] });
  });
});
