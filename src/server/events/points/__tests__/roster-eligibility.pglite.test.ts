import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/**
 * Roster eligibility read against real rows: the event-points bit, not the leaderboard column,
 * keeps an account off the roster. Ids are invented.
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { loadRosterMemberStates } = await import('~/server/events/points/roster-sync');

const EVENT = {
  name: 'e',
  startDate: new Date('2026-11-01T00:00:00Z'),
  teams: ['Blue'],
  join: { claimKey: 'join', design: 'badge' },
};
const PLAIN = 1;
const LEADERBOARD_ONLY = 2;
const EXCLUDED = 3;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, settings jsonb, "bannedAt" timestamptz, "deletedAt" timestamptz,
      "excludeFromLeaderboards" boolean NOT NULL DEFAULT false, flags int NOT NULL DEFAULT 0
    );
    CREATE TABLE "Cosmetic" (id int PRIMARY KEY, type text, data jsonb);
    CREATE TABLE "UserCosmetic" (
      "userId" int, "cosmeticId" int, "claimKey" text, "obtainedAt" timestamptz DEFAULT now(),
      "equippedToId" int
    );
    CREATE TABLE "CosmeticShopItem" ("cosmeticId" int, "unitAmount" int);
    INSERT INTO "User" (id, "excludeFromLeaderboards", flags) VALUES
      (${PLAIN}, false, 0),
      -- DisablePayout rides along so a predicate testing the wrong bit is caught too.
      (${LEADERBOARD_ONLY}, true, ${UserFlag.DisablePayout}),
      (${EXCLUDED}, false, ${UserFlag.DisablePayout | UserFlag.ExcludeFromEventPoints});
  `);
});
afterAll(async () => db.close());

describe('roster eligibility', () => {
  // Decision: leaderboard exclusion and event-points exclusion are separate switches. Before you
  // put "excludeFromLeaderboards" back into this predicate, note that it would drop every
  // leaderboard-only account from the roster.
  it('excludes an account with the event-points bit, and keeps a leaderboard-only one', async () => {
    const raw = pgliteRaw(db);
    const states = await loadRosterMemberStates(EVENT, [PLAIN, LEADERBOARD_ONLY, EXCLUDED], {
      $queryRaw: raw.queryRaw,
    } as never);
    expect(Object.fromEntries(states.map((s) => [s.userId, s.eligible]))).toEqual({
      [PLAIN]: true,
      [LEADERBOARD_ONLY]: true,
      [EXCLUDED]: false,
    });
  });
});
