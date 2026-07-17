import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteUserEngagementsForUser,
  deleteUserLinkForUser,
  deleteUserProfileForUser,
  getConfirmedMutedUsers,
  getUserByIdAndUsername,
  getUserForSoftDelete,
  getUsers,
  scrubDeletedUser,
  searchUsers,
  setUserBan,
  setUserContestBan,
  setUserMuted,
  updateUser,
} from './user.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('searchUsers', () => {
  it('builds a prefix search: like query%, excludes deleted + system user, ordered by username length', async () => {
    await searchUsers(harness.db, { query: 'alice', limit: 5 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "username", "image" from "User" ' +
        'where "username" like $1 and "deletedAt" is null and "id" != $2 ' +
        'order by length(username) asc limit $3'
    );
    // like prefix, system-user guard, limit
    expect(parameters).toEqual(['alice%', -1, 5]);
  });

  it('trims the query and defaults the limit to 10', async () => {
    await searchUsers(harness.db, { query: '  bob  ' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('order by length(username) asc');
    expect(parameters).toEqual(['bob%', -1, 10]);
  });

  it('short-circuits an empty/whitespace query WITHOUT running a query', async () => {
    const result = await searchUsers(harness.db, { query: '   ' });

    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });
});

describe('updateUser', () => {
  it('updates the row and returns it', async () => {
    await updateUser(harness.db, { id: 7, muted: true });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "User" set "muted" = $1 where "id" = $2 returning *');
    expect(parameters).toEqual([true, 7]);
  });

  it('strips the Blocked (32) flag from browsingLevel before writing (enforcement)', async () => {
    await updateUser(harness.db, { id: 7, browsingLevel: 32 | 1 });
    const { parameters } = harness.lastQuery();
    expect(parameters[0]).toBe(1); // 33 & ~32 === 1
  });

  it('leaves browsingLevel untouched when the Blocked flag is absent', async () => {
    await updateUser(harness.db, { id: 7, browsingLevel: 5 });
    const { parameters } = harness.lastQuery();
    expect(parameters[0]).toBe(5);
  });

  it('sets the moderator flag (replaces the collapsed setUserModerator)', async () => {
    await updateUser(harness.db, { id: 7, isModerator: true });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "User" set "isModerator" = $1 where "id" = $2 returning *');
    expect(parameters).toEqual([true, 7]);
  });

  it('sets leaderboard eligibility (replaces the collapsed setLeaderboardEligibility)', async () => {
    await updateUser(harness.db, { id: 7, excludeFromLeaderboards: true });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "User" set "excludeFromLeaderboards" = $1 where "id" = $2 returning *'
    );
    expect(parameters).toEqual([true, 7]);
  });
});

describe('setUserBan / setUserContestBan', () => {
  it('sets bannedAt + meta (jsonb) and returns the row', async () => {
    const meta = { banDetails: { reasonCode: 'TOS', detailsInternal: 'x' } };
    const now = new Date();
    await setUserBan(harness.db, { id: 7, bannedAt: now, meta });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "User" set "bannedAt" = $1, "meta" = $2::jsonb where "id" = $3 returning *'
    );
    expect(parameters[0]).toBe(now);
    expect(parameters[1]).toBe(JSON.stringify(meta)); // toJson, not a pg array literal
    expect(parameters[2]).toBe(7);
  });

  it('clears the ban by writing a null bannedAt', async () => {
    await setUserBan(harness.db, { id: 7, bannedAt: null, meta: {} });
    const { parameters } = harness.lastQuery();
    expect(parameters[0]).toBeNull();
  });

  it('setUserContestBan writes only meta', async () => {
    const meta = { contestBanDetails: { detailsInternal: 'y' } };
    await setUserContestBan(harness.db, { id: 7, meta });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "User" set "meta" = $1::jsonb where "id" = $2 returning *');
    expect(parameters).toEqual([JSON.stringify(meta), 7]);
  });
});

describe('setUserMuted', () => {
  it('stamps mutedAt on mute', async () => {
    await setUserMuted(harness.db, { id: 7, muted: true });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "User" set "muted" = $1, "mutedAt" = $2 where "id" = $3 returning *');
    expect(parameters[0]).toBe(true);
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(7);
  });

  it('clears mutedAt on unmute', async () => {
    await setUserMuted(harness.db, { id: 7, muted: false });
    const { parameters } = harness.lastQuery();
    expect(parameters[0]).toBe(false);
    expect(parameters[1]).toBeNull();
  });
});

describe('getUserForSoftDelete', () => {
  it('reads the guard fields', async () => {
    await getUserForSoftDelete(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "isModerator", "paddleCustomerId" from "User" where "id" = $1');
    expect(parameters).toEqual([7]);
  });
});

describe('getConfirmedMutedUsers', () => {
  it('selects muted users confirmed since the cutoff', async () => {
    const since = new Date();
    await getConfirmedMutedUsers(harness.db, since);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "id" from "User" where "muted" = $1 and "mutedAt" > $2');
    expect(parameters).toEqual([true, since]);
  });
});

describe('getUsers', () => {
  it('builds the full lookup: filters, avatar join, status case, order + limit', async () => {
    await getUsers(harness.db, {
      limit: 25,
      query: 'ali',
      email: 'a@b.com',
      ids: [1, 2],
      include: ['status', 'avatar'],
      excludedUserIds: [9],
      contestBanned: true,
    });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('FROM "User" u');
    expect(sql).toContain('LEFT JOIN "Image" i ON i.id = u."profilePictureId"');
    expect(sql).toContain('AS status');
    expect(sql).toContain('COALESCE(i."nsfwLevel", 0)');
    expect(sql).toContain('u.id IN ('); // guarded id set, never IN ()
    expect(sql).toContain('u.username LIKE');
    expect(sql).toContain('u.email ILIKE');
    expect(sql).toContain('u.id != ALL(');
    expect(sql).toContain('u."deletedAt" IS NULL');
    expect(sql).toContain(`u."meta"->>'contestBanDetails' IS NOT NULL`);
    // ORDER BY lives after the WHERE (not spliced between predicates)
    expect(sql.indexOf('ORDER BY LENGTH(u.username)')).toBeGreaterThan(sql.indexOf('WHERE'));
    expect(sql).toContain('LIMIT');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toEqual([1, 2, 'ali%', 'a@b.com%', [9], 25]);
  });

  it('omits the join / filters / order when not requested', async () => {
    await getUsers(harness.db, {});
    const { sql } = harness.lastQuery();
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).not.toContain('ORDER BY');
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('IN ('); // no id set → TRUE, never IN ()
    expect(sql).toContain('u."deletedAt" IS NULL');
    expect(sql).toContain('u."id" != -1');
  });
});

describe('deleteUser cores', () => {
  it('getUserByIdAndUsername matches on both', async () => {
    await getUserByIdAndUsername(harness.db, { id: 7, username: 'bob' });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "id" from "User" where "id" = $1 and "username" = $2');
    expect(parameters).toEqual([7, 'bob']);
  });

  it('deleteUserEngagementsForUser is the AND-only self-engagement filter (faithful)', async () => {
    await deleteUserEngagementsForUser(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "UserEngagement" where "userId" = $1 and "targetUserId" = $2');
    expect(parameters).toEqual([7, 7]);
  });

  it('scrubDeletedUser nulls PII and sets deletedAt', async () => {
    await scrubDeletedUser(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "User" set "deletedAt" = $1, "email" = $2, "username" = $3, ' +
        '"paddleCustomerId" = $4, "image" = $5, "profilePictureId" = $6 where "id" = $7'
    );
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters.slice(1, 6)).toEqual([null, null, null, null, null]);
    expect(parameters[6]).toBe(7);
  });
});

describe('user sub-entity deletes', () => {
  const simpleDeletes: Array<[string, (userId: number) => unknown, string]> = [
    ['UserLink', (u) => deleteUserLinkForUser(harness.db, u), 'UserLink'],
    ['UserProfile', (u) => deleteUserProfileForUser(harness.db, u), 'UserProfile'],
  ];

  it.each(simpleDeletes)('%s: delete from table where userId', async (_name, fn, table) => {
    await fn(7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(`delete from "${table}" where "userId" = $1`);
    expect(parameters).toEqual([7]);
  });
});
