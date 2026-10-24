import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Two properties that a green suite could not otherwise tell apart from the old code:
 * the showcase must bias the choice of board rather than filter it away, and the
 * per-user path must not TRUNCATE a table the whole site reads.
 */

type Statement = { sql: string; values: unknown[] };

const statements: Statement[] = [];

const mockExecuteRaw = dbMock.dbWrite.$executeRaw;
const mockTransaction = dbMock.dbWrite.$transaction;

// Recording the statement IS the fixture — every assertion here reads `statements`. The
// canonical `$executeRaw` default returns 0 and records nothing, so this is declared rather
// than inherited. `$transaction` likewise: the canonical default runs the callback, this file
// only needs it to resolve.
mockExecuteRaw.mockImplementation((...args: any[]): Statement => {
  const statement: Statement = Array.isArray(args[0])
    ? { sql: args[0].join(' ? '), values: args.slice(1) }
    : { sql: args[0].sql, values: args[0].values };
  statements.push(statement);
  return statement;
});
mockTransaction.mockImplementation(async () => []);

import {
  updateLeaderboardRank,
  updateLeaderboardRankForUsers,
} from '~/server/services/user.service';

const insertStatement = () => {
  const insert = statements.find((s) => s.sql.includes('INSERT INTO "UserRank"'));
  if (!insert) throw new Error(`no UserRank insert issued; got ${statements.length} statement(s)`);
  return insert;
};

beforeEach(() => {
  statements.length = 0;
  vi.clearAllMocks();
});

describe('leaderboard rank — showcase is a preference, not a filter', () => {
  it.each([
    ['full rebuild', () => updateLeaderboardRank()],
    ['per-user rebuild', () => updateLeaderboardRankForUsers({ userIds: 42 })],
  ])('%s ranks the showcased board first instead of excluding the rest', async (_label, run) => {
    await run();
    const { sql } = insertStatement();

    // The old shape dropped every other board: `AND (u."leaderboardShowcase" IS NULL
    // OR lr."leaderboardId" = u."leaderboardShowcase")`. A user whose showcased board
    // can't produce a badge then got no badge at all.
    expect(sql).not.toContain('u."leaderboardShowcase" IS NULL');

    // Direction and term order both carry the fix. `ASC` sorts the showcased board LAST,
    // and putting `lr."position"` first demotes the preference to a tiebreaker — either
    // mutation inverts the behaviour while still mentioning the showcase.
    const orderBy = sql.slice(sql.indexOf('ORDER BY')).replace(/\s+/g, ' ');
    expect(orderBy).toMatch(
      /^ORDER BY \(lr\."leaderboardId" IS NOT DISTINCT FROM u\."leaderboardShowcase"\) DESC, lr\."position"/
    );
  });
});

describe('mature boards earn a badge on every domain', () => {
  /**
   * If you are here because you are about to re-add a domain filter: this was removed
   * deliberately (Justin, 2026-09-04, ClickUp 868m1b61y), and the reasoning is not
   * recoverable from the diff.
   *
   * The old `AND NOT (l.domain <@ ARRAY['red']::"DomainColor"[])` existed so a
   * red-exclusive board's title could not render on civitai.com. Measured on prod the
   * day it was removed: it withheld a badge from 174 users, 120 of whom had no badge at
   * all, to suppress a title containing the word "mature" for 86 of them. 88 of the 174
   * were on `new_creators-red` / `images-new-red`, whose titles are character-identical
   * to their SFW twins, so they leaked nothing and were excluded anyway. The cosmetic
   * art is a chili-pepper motif, not explicit. Justin's call was that the string is
   * acceptable sitewide and the mechanism was not worth its cost.
   *
   * Restoring per-domain badges is a bigger change than restoring this line: `UserRank`
   * is one global row per user and feeds a single users search index, so it would need a
   * domain dimension in both. Re-adding the filter alone just reintroduces the 120.
   *
   * Asserted on the whole statement rather than the exact old line, so a re-spelling
   * that names the column (`&&`, `=`, `@>`, a join to "Leaderboard".domain) fails too.
   * The board-LISTING surface stayed domain-scoped on purpose — see
   * `leaderboard-domain-visibility.test.ts`. Only the badge path opted out.
   */
  it.each([
    ['full rebuild', () => updateLeaderboardRank()],
    ['per-user rebuild', () => updateLeaderboardRankForUsers({ userIds: 42 })],
  ])('%s does not filter candidate boards by domain', async (_label, run) => {
    await run();
    expect(insertStatement().sql).not.toMatch(/domain/i);
  });

  // The statement text elides interpolated values as placeholders, so an exclusion
  // smuggled in as one — `AND lr."leaderboardId" NOT IN (${Prisma.join(RED_IDS)})` —
  // never contains the word "domain" and passes the case above. The full rebuild binds
  // nothing today, so any parameter at all is that shape arriving.
  it('binds no parameters on the full rebuild, so no board list can hide in them', async () => {
    await updateLeaderboardRank();
    expect(insertStatement().values).toEqual([]);
  });

  // The domain filter went; the visibility one did not. Dropping `l.public` would put
  // unlisted boards on profiles, which no part of the above licenses.
  //
  // Matched as a conjunction rather than a substring: `toContain('l.public')` stays
  // green through `AND NOT l.public`, `AND l.public = false` and `OR l.public` — the
  // exact inversions it claims to catch — while breaking on a harmless `l."public"`.
  it('still restricts candidates to public boards', async () => {
    await updateLeaderboardRank();
    const sql = insertStatement().sql.replace(/\s+/g, ' ');

    expect(sql).toMatch(/JOIN "Leaderboard" l ON l\.id = lr\."leaderboardId" AND l\."?public"?/);
    expect(sql).not.toMatch(/NOT\s+l\."?public|l\."?public"?\s*=\s*false/i);
  });
});

describe('updateLeaderboardRankForUsers', () => {
  it('scopes the rebuild to the given users and never truncates', async () => {
    await updateLeaderboardRankForUsers({ userIds: 42 });

    const insert = insertStatement();
    expect(insert.sql).toContain('AND u.id IN');
    expect(insert.values).toEqual([42]);
  });

  // Removing a row is the nightly rebuild's job, and that one is guarded by
  // `isLeaderboardPopulated`. A delete here would strip the badge and then insert
  // nothing on any day the 23:00 population failed.
  it('upserts rather than removing anything', async () => {
    await updateLeaderboardRankForUsers({ userIds: 42 });

    const removing = statements.filter((s) => /DELETE|TRUNCATE/.test(s.sql));
    expect(removing.map((s) => s.sql)).toEqual([]);
    expect(insertStatement().sql).toContain('ON CONFLICT ("userId") DO UPDATE');
  });

  it('accepts a list of users', async () => {
    await updateLeaderboardRankForUsers({ userIds: [7, 9] });
    expect(insertStatement().values).toEqual([7, 9]);
  });

  it('issues nothing for an empty list', async () => {
    await updateLeaderboardRankForUsers({ userIds: [] });
    expect(statements).toEqual([]);
  });
});

describe('updateLeaderboardRank', () => {
  it('still truncates, because it rebuilds every user', async () => {
    await updateLeaderboardRank();
    expect(statements.some((s) => s.sql.includes('TRUNCATE TABLE "UserRank"'))).toBe(true);
    expect(insertStatement().sql).not.toContain('AND u.id IN');
  });
});
