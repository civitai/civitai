import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

// getWinners answers only for a challenge the viewer may see in a public list, and answers a hidden
// one exactly as an unknown id. The visibility SQL runs against real Postgres (PGlite).

const WINNERS = [{ id: 1, userId: 9 }];
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  getChallengeWinners: vi.fn(async () => WINNERS),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const none = { getCached: vi.fn(async () => []) };
  return {
    ...(await importOriginal<typeof UserPreferencesService>()),
    HiddenUsers: none,
    BlockedUsers: none,
    BlockedByUsers: none,
  };
});

const { getVisibleChallengeWinners } = await import('~/server/services/challenge.service');

const SCHEMA = `
  CREATE TYPE "ChallengeSource" AS ENUM ('System', 'Mod', 'User');
  CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled');
  CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, poi boolean NOT NULL DEFAULT false,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "nsfwLevel" int NOT NULL DEFAULT 1
  );
  CREATE TABLE "Challenge" (
    id int PRIMARY KEY, source "ChallengeSource" NOT NULL,
    status "ChallengeStatus" NOT NULL DEFAULT 'Completed',
    ingestion "ChallengeIngestionStatus" NOT NULL DEFAULT 'Scanned', "coverImageId" int,
    "createdById" int NOT NULL, "visibleAt" timestamp(3) NOT NULL DEFAULT now() - interval '1 day',
    "buzzType" text NOT NULL DEFAULT 'yellow', "nsfwLevel" int NOT NULL DEFAULT 1
  );
`;

const PG = 1;
const R = 4;
const VIEWER = 500;
const CREATOR = 7;
const VISIBLE = 1;
const UNSCANNED = 2;
const USER_CHALLENGE = 3;
const ABOVE_LEVEL = 4;
const CANCELLED = 5;
const UNKNOWN = 999;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "Image" (id) VALUES (1), (2), (3), (5);
    INSERT INTO "Image" (id, "nsfwLevel") VALUES (4, ${R});
    INSERT INTO "Challenge" (id, source, "coverImageId", "createdById") VALUES
      (${VISIBLE}, 'System', 1, -1),
      (${USER_CHALLENGE}, 'User', 3, ${CREATOR});
    INSERT INTO "Challenge" (id, source, ingestion, "coverImageId", "createdById") VALUES
      (${UNSCANNED}, 'User', 'Pending', 2, ${CREATOR});
    INSERT INTO "Challenge" (id, source, "coverImageId", "createdById", "nsfwLevel") VALUES
      (${ABOVE_LEVEL}, 'System', 4, -1, ${R});
    INSERT INTO "Challenge" (id, source, status, "coverImageId", "createdById") VALUES
      (${CANCELLED}, 'User', 'Cancelled', 5, ${CREATOR});
  `);
});
afterAll(() => harness.stop());

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.$queryRaw>
  ) => harness.prisma.$queryRaw(...args)) as never);
});

const winners = (
  challengeId: number,
  viewer: {
    isModerator?: boolean;
    canAccessUserChallenges?: boolean;
    viewerId?: number;
    browsingLevel?: number;
  } = {}
) =>
  getVisibleChallengeWinners({
    challengeId,
    isGreen: false,
    viewerId: VIEWER,
    browsingLevel: PG,
    canAccessUserChallenges: true,
    ...viewer,
  });

describe('getVisibleChallengeWinners', () => {
  it('returns the winners of a challenge the viewer can see', async () => {
    expect(await winners(VISIBLE)).toEqual(WINNERS);
  });

  it('answers an unknown id with an empty list', async () => {
    expect(await winners(UNKNOWN)).toEqual([]);
  });

  it('answers a challenge hidden by its scan the same way', async () => {
    expect(await winners(UNSCANNED)).toEqual([]);
  });

  it('keeps user challenges behind the userChallenges flag, and by default', async () => {
    expect(await winners(USER_CHALLENGE, { canAccessUserChallenges: false })).toEqual([]);
    expect(
      await getVisibleChallengeWinners({
        challengeId: USER_CHALLENGE,
        isGreen: false,
        viewerId: VIEWER,
      })
    ).toEqual([]);
    expect(await winners(USER_CHALLENGE)).toEqual(WINNERS);
  });

  it("answers a challenge above the viewer's level the same way", async () => {
    expect(await winners(ABOVE_LEVEL)).toEqual([]);
    expect(await winners(ABOVE_LEVEL, { browsingLevel: PG | R })).toEqual(WINNERS);
  });

  // getChallengeWinners is stubbed to always return winners, so an empty answer is the gate's.
  it('answers a Cancelled challenge the same way, except to its creator and moderators', async () => {
    expect(await winners(CANCELLED)).toEqual([]);
    expect(await winners(CANCELLED, { viewerId: undefined })).toEqual([]);
    expect(await winners(CANCELLED, { viewerId: CREATOR })).toEqual(WINNERS);
    expect(await winners(CANCELLED, { isModerator: true })).toEqual(WINNERS);
  });

  it('lets the creator see their own unscanned challenge, as the feed does', async () => {
    expect(await winners(UNSCANNED, { viewerId: CREATOR })).toEqual(WINNERS);
  });

  it('lets a moderator see a hidden challenge, as the detail page does, but not past the flag', async () => {
    expect(await winners(UNSCANNED, { isModerator: true })).toEqual(WINNERS);
    expect(await winners(ABOVE_LEVEL, { isModerator: true })).toEqual(WINNERS);
    expect(
      await winners(USER_CHALLENGE, { isModerator: true, canAccessUserChallenges: false })
    ).toEqual([]);
  });
});
