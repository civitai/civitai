import { beforeEach, describe, expect, it } from 'vitest';
import {
  createStrike,
  evaluateStrikeEscalation,
  expireStrikes,
  findUserIdByUsername,
  getActiveStrikePoints,
  getActiveStrikePointsForUpdate,
  getStrikeSummary,
  getStrikesForMod,
  getStrikesForUser,
  getUserMuteState,
  getUsersToUnmute,
  getUserStandings,
  insertUserStrike,
  processTimedUnmutes,
  setUserMuteState,
  shouldRateLimitStrike,
  voidStrike,
} from './strike.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

const find = (needle: string) => h.queries.find((q) => q.sql.includes(needle));

describe('shouldRateLimitStrike', () => {
  it('counts today non-manual strikes for the user', async () => {
    await shouldRateLimitStrike(h.db, 42);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('SELECT COUNT(*) as count');
    expect(sql).toContain('"createdAt" >= CURRENT_DATE');
    expect(sql).toContain('"reason" != $2::"StrikeReason"');
    expect(parameters).toEqual([42, 'ManualModAction']);
  });
});

describe('getActiveStrikePoints', () => {
  it('sums active non-expired points', async () => {
    await getActiveStrikePoints(h.db, 42);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('SELECT SUM(points) as sum');
    expect(sql).toContain('"status" = $2::"StrikeStatus"');
    expect(sql).toContain('"expiresAt" > NOW()');
    expect(sql).not.toContain('FOR UPDATE');
    expect(parameters).toEqual([42, 'Active']);
  });
});

describe('getActiveStrikePointsForUpdate', () => {
  it('takes a row lock (FOR UPDATE)', async () => {
    await getActiveStrikePointsForUpdate(h.db, 42);
    const { sql } = h.lastQuery();
    // Lock is taken in the subquery (FOR UPDATE can't sit alongside the aggregate); outer query sums.
    expect(sql).toContain('COALESCE(SUM(points), 0) as sum');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain(') locked');
  });
});

describe('getStrikeSummary', () => {
  it('returns count, sum and next expiry in one query', async () => {
    await getStrikeSummary(h.db, 42);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('COUNT(*) as count');
    expect(sql).toContain('SUM(points) as sum');
    expect(sql).toContain('MIN("expiresAt") as next_expiry');
    expect(parameters).toEqual([42, 'Active']);
  });
});

describe('getStrikesForUser', () => {
  it('filters to Active by default and omits internal notes', async () => {
    await getStrikesForUser(h.db, { userId: 42 });
    const list = find('"issuedByUser"');
    expect(list).toBeDefined();
    expect(list!.sql).toContain('where "UserStrike"."userId" = $1');
    expect(list!.sql).toContain('"UserStrike"."status" = $2');
    expect(list!.sql).not.toContain('"internalNotes"');
    expect(list!.sql).toContain('order by "UserStrike"."createdAt" desc');
    expect(list!.parameters).toEqual([42, 'Active']);
  });

  it('includes internal notes and expired strikes when requested (mod view)', async () => {
    await getStrikesForUser(h.db, {
      userId: 42,
      includeExpired: true,
      includeInternalNotes: true,
    });
    const list = find('"issuedByUser"');
    expect(list!.sql).toContain('"UserStrike"."internalNotes"');
    expect(list!.sql).not.toContain('"UserStrike"."status" =');
    expect(list!.parameters).toEqual([42]);
  });
});

describe('findUserIdByUsername', () => {
  it('does a case-insensitive exact match', async () => {
    await findUserIdByUsername(h.db, 'Alice');
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select "id" from "User" where "username" ilike $1');
    expect(parameters).toEqual(['Alice']);
  });
});

describe('getStrikesForMod', () => {
  it('short-circuits to an empty page when a username filter matches no user', async () => {
    const result = await getStrikesForMod(h.db, { limit: 20, page: 1, username: 'ghost' });
    expect(result).toEqual({ items: [], count: 0 });
    // Only the username lookup ran — never the strike list/count.
    expect(h.queries).toHaveLength(1);
    expect(h.lastQuery().sql).toContain('from "User"');
  });

  it('filters by user/status/reason and pages newest-first', async () => {
    await getStrikesForMod(h.db, {
      limit: 10,
      page: 3,
      userId: 42,
      status: ['Active'],
      reason: ['TOSViolation'],
    });
    const items = find('"issuedByUser"');
    expect(items).toBeDefined();
    expect(items!.sql).toContain('"UserStrike"."userId" = $1');
    expect(items!.sql).toContain('"UserStrike"."status" in ($2)');
    expect(items!.sql).toContain('"UserStrike"."reason" in ($3)');
    expect(items!.sql).toContain('order by "UserStrike"."createdAt" desc');
    expect(items!.sql).toContain('limit $4');
    expect(items!.sql).toContain('offset $5');
    // status, reason, limit=10, offset=(3-1)*10
    expect(items!.parameters).toEqual([42, 'Active', 'TOSViolation', 10, 20]);
  });

  it('guards empty status/reason arrays (no IN ())', async () => {
    await getStrikesForMod(h.db, { limit: 10, userId: 42, status: [], reason: [] });
    const items = find('"issuedByUser"');
    expect(items!.sql).not.toContain('in ()');
    expect(items!.sql).not.toContain('"status" in');
    expect(items!.sql).not.toContain('"reason" in');
  });
});

describe('getUserStandings', () => {
  it('INNER JOINs by default with no user filter', async () => {
    await getUserStandings(h.db, { limit: 20, page: 1 });
    const items = find('"totalActivePoints"');
    expect(items!.sql).toContain('INNER JOIN "UserStrike"');
    expect(items!.sql).not.toContain('LEFT JOIN "UserStrike"');
    // No filter/having clauses (WHERE still appears inside the COUNT(*) FILTER (WHERE ...) aggregates).
    expect(items!.sql).not.toContain('u."id" = $');
    expect(items!.sql).not.toContain('ILIKE');
    expect(items!.sql).not.toContain('HAVING COUNT');
    expect(items!.sql).toContain('ORDER BY "totalActivePoints" DESC NULLS LAST');
    expect(items!.sql).toContain('LIMIT');
    expect(items!.sql).toContain('OFFSET');
  });

  it('LEFT JOINs and applies filters/having/sort when searching', async () => {
    await getUserStandings(h.db, {
      limit: 20,
      page: 1,
      userId: 42,
      isMuted: true,
      isFlaggedForReview: true,
      hasActiveStrikes: true,
      sort: 'score',
      sortOrder: 'asc',
    });
    const items = find('"totalActivePoints"');
    expect(items!.sql).toContain('LEFT JOIN "UserStrike"');
    expect(items!.sql).toContain('WHERE');
    expect(items!.sql).toContain('u."id" = $1');
    expect(items!.sql).toContain('u."muted" = true');
    expect(items!.sql).toContain(`(u."meta"->>'strikeFlaggedForReview')::boolean = true`);
    expect(items!.sql).toContain('HAVING COUNT(*) FILTER');
    expect(items!.sql).toContain('ORDER BY "userScore" ASC NULLS LAST');
  });

  it('runs an items query and a matching count query', async () => {
    await getUserStandings(h.db, { limit: 20, page: 1 });
    expect(find('"totalActivePoints"')).toBeDefined();
    expect(find('SELECT COUNT(*) as count FROM (')).toBeDefined();
  });
});

describe('getUserMuteState', () => {
  it('reads muted / muteExpiresAt / meta', async () => {
    await getUserMuteState(h.db, 42);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select "muted", "muteExpiresAt", "meta" from "User" where "id" = $1');
    expect(parameters).toEqual([42]);
  });
});

describe('setUserMuteState', () => {
  it('updates mute flags without touching meta when meta omitted', async () => {
    await setUserMuteState(h.db, { userId: 42, muted: false, muteExpiresAt: null });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('update "User" set "muted" = $1, "muteExpiresAt" = $2 where "id" = $3');
    expect(sql).not.toContain('"meta"');
    expect(parameters).toEqual([false, null, 42]);
  });

  it('writes the whole meta jsonb via toJson when provided', async () => {
    await setUserMuteState(h.db, {
      userId: 42,
      muted: true,
      muteExpiresAt: null,
      meta: { strikeFlaggedForReview: true },
    });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('"meta" = $3::jsonb');
    expect(parameters[2]).toBe(JSON.stringify({ strikeFlaggedForReview: true }));
  });
});

describe('evaluateStrikeEscalation', () => {
  it('reads points (FOR UPDATE) and mute state inside a transaction', async () => {
    // With the DummyDriver both reads return empty, so the decision resolves to `none` without a write.
    const result = await evaluateStrikeEscalation(h.db, 42);
    expect(result).toEqual({ totalPoints: 0, action: 'none' });
    expect(find('FOR UPDATE')).toBeDefined();
    expect(find('select "muted", "muteExpiresAt", "meta"')).toBeDefined();
  });
});

describe('insertUserStrike', () => {
  it('inserts and returns the row, defaulting optional columns to null', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is still logged first.
    await insertUserStrike(h.db, {
      userId: 42,
      reason: 'ManualModAction',
      points: 2,
      description: 'bad',
      expiresAt: new Date('2030-01-01'),
    }).catch(() => {});
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('insert into "UserStrike"');
    expect(sql).toContain('returning *');
    expect(parameters).toEqual([
      42,
      'ManualModAction',
      2,
      'bad',
      null,
      null,
      null,
      null,
      expect.any(Date),
      null,
    ]);
  });
});

describe('createStrike', () => {
  it('skips the rate-limit query for a manual strike and inserts', async () => {
    await createStrike(h.db, {
      userId: 42,
      reason: 'ManualModAction',
      points: 1,
      description: 'manual',
      expiresInDays: 30,
    }).catch(() => {});
    // No rate-limit COUNT query for a manual strike.
    expect(find('"reason" != $2::"StrikeReason"')).toBeUndefined();
    expect(find('insert into "UserStrike"')).toBeDefined();
  });

  it('runs the rate-limit check first for a non-manual strike', async () => {
    await createStrike(h.db, {
      userId: 42,
      reason: 'TOSViolation',
      points: 1,
      description: 'auto',
      expiresInDays: 30,
    }).catch(() => {});
    expect(h.queries[0].sql).toContain('"reason" != $2::"StrikeReason"');
    expect(find('insert into "UserStrike"')).toBeDefined();
  });
});

describe('voidStrike', () => {
  it('atomically voids only an Active strike, returning the row', async () => {
    await voidStrike(h.db, { strikeId: 7, voidReason: 'mistake', voidedBy: 99 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "UserStrike" set "status" = $1, "voidedAt" = $2, "voidedBy" = $3, "voidReason" = $4 ' +
        'where "id" = $5 and "status" = $6 returning *'
    );
    expect(parameters[0]).toBe('Voided');
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(99);
    expect(parameters[3]).toBe('mistake');
    expect(parameters[4]).toBe(7);
    expect(parameters[5]).toBe('Active');
  });
});

describe('expireStrikes', () => {
  it('expires Active strikes past expiry in one returning update', async () => {
    await expireStrikes(h.db);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "UserStrike" set "status" = $1 ' +
        'where "status" = $2 and "expiresAt" <= $3 returning "id", "userId"'
    );
    expect(parameters[0]).toBe('Expired');
    expect(parameters[1]).toBe('Active');
    expect(parameters[2]).toBeInstanceOf(Date);
  });
});

describe('getUsersToUnmute', () => {
  it('finds muted users whose timed mute has lapsed', async () => {
    await getUsersToUnmute(h.db);
    const { sql } = h.lastQuery();
    expect(sql).toBe(
      'select "id" from "User" ' +
        'where "muted" = $1 and "muteExpiresAt" is not null and "muteExpiresAt" <= $2'
    );
  });
});

describe('processTimedUnmutes', () => {
  it('short-circuits when no users have lapsed mutes', async () => {
    const result = await processTimedUnmutes(h.db);
    expect(result).toEqual({ unmutedCount: 0 });
    expect(h.queries).toHaveLength(1);
    expect(h.lastQuery().sql).toContain('"muteExpiresAt" is not null');
  });
});
