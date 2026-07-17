import { afterAll, describe, expect, it } from 'vitest';
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
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — validates that the
// columns/joins/types resolve against the real database without executing the statement. Skips when no DB
// URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('users queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('searchUsers plans against the real schema', async () => {
    await searchUsers(h.db, { query: 'a', limit: 5 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateUser plans', async () => {
    await updateUser(h.db, { id: -1, muted: true, browsingLevel: 33 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserBan plans', async () => {
    await setUserBan(h.db, {
      id: -1,
      bannedAt: new Date(),
      meta: { banDetails: { reasonCode: 'x' } },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserContestBan plans', async () => {
    await setUserContestBan(h.db, { id: -1, meta: { contestBanDetails: {} } });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserMuted plans', async () => {
    await setUserMuted(h.db, { id: -1, muted: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUserForSoftDelete plans', async () => {
    await getUserForSoftDelete(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getConfirmedMutedUsers plans', async () => {
    await getConfirmedMutedUsers(h.db, new Date());
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUsers (full filter set) plans', async () => {
    await getUsers(h.db, {
      limit: 10,
      query: 'a',
      email: 'a@b.com',
      ids: [-1, -2],
      include: ['status', 'avatar'],
      excludedUserIds: [-3],
      contestBanned: true,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUsers (minimal) plans', async () => {
    await getUsers(h.db, {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUserByIdAndUsername plans', async () => {
    await getUserByIdAndUsername(h.db, { id: -1, username: 'x' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteUserEngagementsForUser plans', async () => {
    await deleteUserEngagementsForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('scrubDeletedUser plans', async () => {
    await scrubDeletedUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  const simpleDeletes: Array<[string, () => Promise<unknown>]> = [
    ['deleteUserLinkForUser', () => deleteUserLinkForUser(h.db, -1)],
    ['deleteUserProfileForUser', () => deleteUserProfileForUser(h.db, -1)],
  ];

  it.each(simpleDeletes)('%s plans', async (_name, fn) => {
    await fn();
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
