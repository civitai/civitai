import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// The challenge feed's visibility rule, run as real SQL: a creator sees their own challenge past the
// level, scan and visibility gates, unless the caller turns that exemption off (the semantic
// search does, so a minor-narrowed query can't show the creator their own challenge above it).

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: async () => [] };
  return {
    ...(await importOriginal<typeof UserPreferences>()),
    HiddenUsers: none,
    BlockedUsers: none,
    BlockedByUsers: none,
  };
});

const { challengeVisibilityConditions } = await import('~/server/services/challenge.service');

const SCHEMA = `
  CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
  CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, poi boolean NOT NULL DEFAULT false,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "nsfwLevel" int NOT NULL
  );
  CREATE TABLE "Challenge" (
    id int PRIMARY KEY, "createdById" int, source "ChallengeSource" NOT NULL DEFAULT 'User',
    ingestion "ChallengeIngestionStatus" NOT NULL DEFAULT 'Scanned', "coverImageId" int,
    "visibleAt" timestamp NOT NULL DEFAULT now() - interval '1 day',
    "buzzType" text NOT NULL DEFAULT 'yellow', "nsfwLevel" int NOT NULL
  );
`;

const OWNER = 7;
const PG = 1;
const R = 4;

let pg: PGlite;
beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  await pg.exec(`
    INSERT INTO "Image" VALUES (1, false, 'Scanned', ${PG}), (2, false, 'Scanned', ${R});
    -- 1: PG. 2: the owner's, cover re-rated R. 3: the owner's, not yet scanned. 4: someone else's,
    -- R. 5: the owner's, not yet visible. 6: the owner's, in the other domain's currency.
    INSERT INTO "Challenge" (id, "createdById", "coverImageId", "nsfwLevel", ingestion) VALUES
      (1, 50, 1, ${PG}, 'Scanned'), (2, ${OWNER}, 2, ${R}, 'Scanned'),
      (3, ${OWNER}, 1, ${PG}, 'Pending'), (4, 51, 2, ${R}, 'Scanned');
    INSERT INTO "Challenge" (id, "createdById", "coverImageId", "nsfwLevel", "visibleAt") VALUES
      (5, ${OWNER}, 1, ${PG}, now() + interval '1 day');
    INSERT INTO "Challenge" (id, "createdById", "coverImageId", "nsfwLevel", "buzzType") VALUES
      (6, ${OWNER}, 1, ${PG}, 'green');
  `);
});
afterAll(() => pg.close());

async function visible(viewerId: number | undefined, ownRowsExempt?: boolean) {
  const conditions = await challengeVisibilityConditions({
    isGreen: false,
    viewerId,
    canAccessUserChallenges: true,
    browsingLevel: PG,
    ownRowsExempt,
  });
  const sql = Prisma.sql`SELECT c.id FROM "Challenge" c WHERE ${Prisma.join(
    conditions,
    ' AND '
  )} ORDER BY c.id`;
  const { rows } = await pg.query<{ id: number }>(sql.text, sql.values);
  return rows.map((r) => r.id);
}

describe('challengeVisibilityConditions: the owner exemption', () => {
  it('lets the creator see their own challenge past every gate by default', async () => {
    expect(await visible(OWNER)).toEqual([1, 2, 3, 5, 6]);
  });

  it('holds the creator to every gate when the exemption is off', async () => {
    expect(await visible(OWNER, false)).toEqual([1]);
  });

  it('never shows another creator their challenge either way', async () => {
    expect(await visible(99)).toEqual([1]);
    expect(await visible(99, false)).toEqual([1]);
  });
});
