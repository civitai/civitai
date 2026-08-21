import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { UserEngagementType } from '~/shared/utils/prisma/enums';
import { HiddenUsers, toggleHidden } from '~/server/services/user-preferences.service';
import { userFollowsCache } from '~/server/redis/caches';
import { toggleFollowUser } from '~/server/services/user.service';
import { clearUserEngagement, setUserEngagement } from '~/server/services/user-engagement';

const { Prisma } = await import('@prisma/client');

// The real class, because `isPrismaUniqueViolation` is an `instanceof` check — a
// duck-typed `{ code: 'P2002' }` is rethrown, and a test using one would report the
// catch as broken when it works.
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const userId = 42;
const targetUserId = 99;
const engagement = dbMock.dbWrite.userEngagement;

// The one row this table allows for the pair. Every assertion below is really
// about which `type` survives a write aimed at a different one.
const scoped = { userId, targetUserId };

// Every pass fails: nothing claimable to update, and the insert always conflicts.
// The fake must TERMINATE on its own — an unbounded-loop mutant driven by a
// persistent `mockResolvedValue` is a pure MICROTASK spin, measured at 4.24M
// iterations in 4s with a queued 300ms setTimeout that never ran. vitest's
// testTimeout is setTimeout-based, so that mutant does not fail, it kills the
// worker with `Worker exited unexpectedly` and no test named. Throwing after ten
// passes turns it into a named failure in under a second.
const everyPassFails = () => {
  const state = { passes: 0 };
  engagement.updateMany.mockImplementation(async () => {
    if (++state.passes > 10) throw new Error(`setUserEngagement did not stop: ${state.passes}`);
    return { count: 0 };
  });
  engagement.create.mockRejectedValue(p2002());
  return state;
};

const hide = (hidden?: boolean) =>
  toggleHidden({ kind: 'user', data: [{ id: targetUserId }], hidden, userId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // `mockResolvedValue`, not `...Once` — `clearAllMocks` is `mockClear` and does not
  // drain a queued once-implementation, so a test that threw early would leak its
  // fixture into the next one.
  engagement.findUnique.mockResolvedValue(null);
  // `toggleFollowUser`'s create selects `user.username` for the follow
  // notification, so a bare `{}` throws on the success path rather than failing an
  // assertion — a fixture gap that reads as a code bug.
  engagement.create.mockResolvedValue({ user: { username: 'target' } });
  engagement.deleteMany.mockResolvedValue({ count: 0 });
  // A row matched by default, so a test that means "nothing matched" has to say so.
  engagement.updateMany.mockResolvedValue({ count: 1 });
});

// The LAST spy created in a file has no following `beforeEach` to restore it, so
// the `beforeEach` above is order-dependent on its own. This makes it not.
afterEach(() => {
  vi.restoreAllMocks();
});

// 868kunqg5. `UserEngagement` is one row per (user, target) carrying one type, so a
// write addressed by the PK alone lands on whatever type occupies it — including a
// Block applied a millisecond earlier, which is then gone with a success reported.
// These assert the shape rather than any one interleaving: a test cannot schedule the
// race, but it can prove no writer is capable of it.
describe('UserEngagement writers are all scoped by type', () => {
  const unqualified = () => [...engagement.delete.mock.calls, ...engagement.update.mock.calls];

  // `it.each` rather than a loop inside one `it`: a loop aborts on the first bad
  // row and leaves the rest of the matrix unmeasured, and its failure names no
  // fixture — you get an argument dump and have to work out which case produced it.
  it.each([
    ['Block', true],
    ['Block', false],
    ['Follow', true],
    ['Follow', false],
    ['Hide', true],
    ['Hide', false],
    ['Hide', undefined],
  ] as const)(
    'toggleHidden kind=user issues no PK-addressed write over a %s row (hidden=%s)',
    async (type, hidden) => {
      engagement.findUnique.mockResolvedValue({ type });

      await hide(hidden);

      expect(unqualified()).toEqual([]);
    }
  );

  it.each(['Block', 'Follow', 'Hide'] as const)(
    'toggleFollowUser issues no PK-addressed write over a %s row',
    async (type) => {
      engagement.findUnique.mockResolvedValue({ type });

      await toggleFollowUser({ userId, targetUserId });

      expect(unqualified()).toEqual([]);
    }
  );
});

// 868kun67j. The unconditional `else` here updated the row to `Hide` whatever it
// held, so hiding someone you had blocked overwrote the block — no race needed, from
// the ordinary product UI, with nothing shown to the user.
describe('toggleHidden kind=user — a Block outranks a Hide', () => {
  it('hiding a BLOCKED user leaves the block standing', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });
    engagement.updateMany.mockResolvedValue({ count: 0 });

    await hide(true);

    // The `type` filter is the protection, so assert the filter itself: an
    // unscoped updateMany passes a bare "was it called" check and still eats the
    // block.
    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, type: { notIn: ['Block'] } },
      data: { type: 'Hide' },
    });
    expect(engagement.deleteMany).not.toHaveBeenCalled();
  });

  it('survives the create losing to the Block row', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });
    everyPassFails();

    // Nothing matched the update and the insert conflicts with the block — the
    // intended end state either way, so the toggle must not 500 on a safety
    // control.
    await expect(hide(true)).resolves.toEqual({ added: [], removed: [], hidden: false });
  });

  it('still surfaces a create failure that is not the conflict', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });
    engagement.create.mockRejectedValue(new Error('connection terminated'));

    // Control for the test above: a bare `catch (() => {})` would pass that one
    // and swallow every real write failure with it.
    await expect(hide(true)).rejects.toThrow('connection terminated');
  });

  it('un-hiding a BLOCKED user does not lift the block', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await hide(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Hide' } });
    expect(engagement.create).not.toHaveBeenCalled();
  });

  it('un-hiding a FOLLOWED user does not drop the follow', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    await hide(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Hide' } });
  });
});

// The second half of 868kun67j: asked to UN-hide a pair with no row at all, the old
// branch fell through to the `else` and created a `Hide` — the same dropped-intent
// shape as the block bug, with `setTo` available and unread.
describe('toggleHidden kind=user — honours the caller intent', () => {
  it('hidden=false with no engagement never creates one', async () => {
    await hide(false);

    expect(engagement.create).not.toHaveBeenCalled();
    expect(engagement.updateMany).not.toHaveBeenCalled();
    // Assert the un-hide still took its own path, so deleting the branch outright
    // cannot pass on the negative alone.
    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Hide' } });
  });

  it('hidden=true with no engagement creates the Hide', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });

    await hide(true);

    expect(engagement.create).toHaveBeenCalledWith({
      data: { userId, targetUserId, type: 'Hide' },
    });
  });

  it('hiding a FOLLOWED user converts that Follow and nothing else', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    await hide(true);

    // The filter is the protection: unscoped, this same statement is what takes a
    // Block with it.
    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, type: { notIn: ['Block'] } },
      data: { type: 'Hide' },
    });
    expect(engagement.deleteMany).not.toHaveBeenCalled();
  });

  it('hidden=true on an ALREADY hidden user is a no-op that keeps the row', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });

    await hide(true);

    expect(engagement.deleteMany).not.toHaveBeenCalled();
    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, type: { notIn: ['Block'] } },
      data: { type: 'Hide' },
    });
    // Paired with the positive above, so this is not a free-pass negative: making
    // the create unconditional would insert over a row the update just matched.
    expect(engagement.create).not.toHaveBeenCalled();
  });

  it('hidden omitted still flips a Hide off, so intent-less callers are unchanged', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });

    await hide(undefined);

    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Hide' } });
    expect(engagement.updateMany).not.toHaveBeenCalled();
  });

  it('hidden omitted with no engagement hides — the fallback must work both ways', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });

    await hide(undefined);

    // Without this the suite cannot tell `setTo ?? !alreadyHidden` from
    // `setTo === true`: every other omitted-intent case starts from a Hide row,
    // where both forms agree — and that mutant makes the `findUnique` read dead.
    expect(engagement.create).toHaveBeenCalledWith({
      data: { userId, targetUserId, type: 'Hide' },
    });
  });
});

// 868kurj0y. The client marks the target hidden optimistically on click, and the
// `added`/`removed` diff cannot correct it: five of the six kinds return both empty
// on every call, so an empty diff is indistinguishable from a refusal. Both
// polarities, or a hardcoded `hidden: false` passes the refusal case alone.
describe('toggleHidden kind=user — reports the outcome the client must trust', () => {
  it('reports hidden=false when a Block refuses the hide', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });
    everyPassFails();

    await expect(hide(true)).resolves.toMatchObject({ hidden: false });
  });

  it('reports hidden=true when the hide lands', async () => {
    await expect(hide(true)).resolves.toMatchObject({ hidden: true });
  });

  // The distinguishing case for the whole field: `findUnique` saw NOTHING, so a
  // `hidden` re-derived from that read reports true. Only the write's own answer
  // reports false. Without this, `hidden = hiding && engagement?.type !== 'Block'`
  // passes every other test in this file.
  it('reports hidden=false when a Block arrives AFTER the read', async () => {
    everyPassFails();

    await expect(hide(true)).resolves.toMatchObject({ hidden: false });
  });

  it('reports hidden=false on an un-hide', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });

    await expect(hide(false)).resolves.toMatchObject({ hidden: false });
  });
});

// 868kurrfj. There used to be a SECOND `toggleHideUser`, in user.service, reachable
// only from a controller handler registered on no router. It is gone: a second live
// writer on this table is the defect family PR #4230 exists to close, and the
// divergence it accumulated (a missing HiddenUsers invalidation) accumulated
// precisely because no call path exercised it. Its branch coverage was not deleted —
// every case it pinned is asserted above against `toggleHidden({ kind: 'user' })`,
// the writer the product actually reaches, except the one below which it alone had.

describe('toggleFollowUser — scoped writes', () => {
  it('unfollowing deletes the Follow row, not whatever occupies the pair', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Follow' } });
  });

  it('following over a Hide converts that Hide and nothing else', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(true);

    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, type: 'Hide' },
      data: { type: 'Follow' },
    });
  });

  it('reports NO follow when the Hide it read is gone', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    engagement.updateMany.mockResolvedValue({ count: 0 });

    // Zero rows means a Block took the pair in between. Returning true here is what
    // pays a follow reward and fires a notification for a follow that does not exist.
    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);
  });

  it('leaves a blocked pair alone entirely', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.updateMany).not.toHaveBeenCalled();
    expect(engagement.deleteMany).not.toHaveBeenCalled();
    expect(engagement.create).not.toHaveBeenCalled();
  });

  // The create path's P2002 used to mean "the toggle raced itself, the follow
  // exists". Once every writer is scoped it means only "something holds the PK",
  // and `toggleFollowUserHandler` pays a Buzz reward and fires a notification on
  // the strength of the return value.
  // Only a Follow is a follow. `winner?.type !== 'Block'` reads as equivalent and
  // is not: it pays the reward for a Hide the user's own toggle established in the
  // race, and for a pair that was cleared between the conflict and the re-read.
  it.each([
    ['Block', false],
    ['Hide', false],
    [null, false],
    ['Follow', true],
  ] as const)('reports the pair honestly when %s won the insert race', async (type, expected) => {
    engagement.create.mockRejectedValue(p2002());
    engagement.findUnique
      .mockResolvedValueOnce(null) // the read that chose the create path
      .mockResolvedValueOnce(type === null ? null : { type }); // what actually holds it

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(expected);

    // Pins the re-read itself, so a mutant that skips it fails in the test that
    // owns it rather than leaking its queued fixture into the next one.
    expect(engagement.findUnique).toHaveBeenCalledTimes(2);
  });

  it('still reports a follow when the toggle merely raced ITSELF', async () => {
    engagement.create.mockRejectedValue(p2002());
    engagement.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ type: 'Follow' });

    // Control for the test above: returning a blanket `false` on P2002 would make
    // a duplicate follow report failure, and the button flip back.
    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(true);
  });
});

// `HiddenUsers` is keyed on `type = 'Hide'` and its TTL is set NX on first
// population, so a write that changes the Hide set without refreshing it stays
// invisible until the whole per-user hash ages out.
describe('cache invalidation on the Hide set', () => {
  it('refreshes HiddenUsers when a follow converts a Hide away', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    const hidden = vi.spyOn(HiddenUsers, 'refreshCache').mockResolvedValue(undefined);

    await toggleFollowUser({ userId, targetUserId });

    // Without this the user follows someone who stays filtered out of their feed.
    expect(hidden).toHaveBeenCalledWith({ userId });
  });

  it.each([true, false])('refreshes HiddenUsers on the hide path (hidden=%s)', async (hidden) => {
    const spy = vi.spyOn(HiddenUsers, 'refreshCache').mockResolvedValue(undefined);

    await hide(hidden);

    // Both directions: gating this on `hiding` would leave an un-hidden user
    // filtered out of their own feed until the per-user hash aged out.
    expect(spy).toHaveBeenCalledWith({ userId });
  });
});

// The write sequence is two passes, never more. Pass two exists for one schedule:
// the pair was empty at the update, a CLAIMABLE row was inserted before ours, so
// the update matched nothing and the create hit the PK. Stopping after one pass
// drops the write while reporting it applied.
describe('setUserEngagement — the second pass, and its ceiling', () => {
  it('retries the scoped update when a claimable row won the insert race', async () => {
    engagement.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    engagement.create.mockRejectedValueOnce(p2002());

    await hide(true);

    expect(engagement.updateMany).toHaveBeenCalledTimes(2);
    expect(engagement.create).toHaveBeenCalledTimes(1);
  });

  it('gives up after the second pass rather than spinning', async () => {
    // The fake TERMINATES on its own. Against a standing Block an unbounded loop
    // here is a pure microtask loop — measured at 4.24M iterations in 4s with a
    // queued 300ms setTimeout that never ran — and vitest's testTimeout is
    // setTimeout-based, so the run would hang until CI killed it with no
    // assertion to read. A fake that throws turns that into a named failure in
    // under a second; `toBe(2)` still pins the ceiling from below.
    const state = everyPassFails();

    await hide(true);

    expect(state.passes).toBe(2);
    expect(engagement.create).toHaveBeenCalledTimes(2);
  });
});

// The precedence order lives in exactly one place, so this is where it is pinned.
// It used to be an optional `outrankedBy` argument, which defaults to NO guard —
// omitting it at one call site silently reproduces 868kun67j.
describe('setUserEngagement — the guard is derived from the type, not passed in', () => {
  it.each([
    [
      UserEngagementType.Follow,
      { type: { notIn: [UserEngagementType.Hide, UserEngagementType.Block] } },
    ],
    [UserEngagementType.Hide, { type: { notIn: [UserEngagementType.Block] } }],
    // Nothing outranks a Block, so its update carries no type filter at all.
    [UserEngagementType.Block, {}],
  ])('claims a pair for %s only against what it outranks', async (type, guard) => {
    await setUserEngagement({ userId, targetUserId, type });

    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, ...guard },
      data: { type },
    });
  });
});

// Both helpers advertise a boolean, and nothing in the repo reads it today — which
// is correct for a hide, since the only way `setUserEngagement` returns false is a
// standing Block and a blocked target is hidden. Pinned anyway: this module is the
// one place every future writer is meant to go through, so its contract should
// break loudly rather than drift.
describe('user-engagement helpers — the returned contract', () => {
  it('reports the claim when the scoped update matched', async () => {
    await expect(
      setUserEngagement({ userId, targetUserId, type: UserEngagementType.Hide })
    ).resolves.toBe(true);
  });

  it('reports the claim when the row had to be created', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      setUserEngagement({ userId, targetUserId, type: UserEngagementType.Hide })
    ).resolves.toBe(true);
  });

  it('reports NO claim when something outranking holds the pair', async () => {
    everyPassFails();

    await expect(
      setUserEngagement({ userId, targetUserId, type: UserEngagementType.Hide })
    ).resolves.toBe(false);
  });

  it('reports whether a row was actually removed', async () => {
    engagement.deleteMany.mockResolvedValue({ count: 1 });
    await expect(
      clearUserEngagement({ userId, targetUserId, type: UserEngagementType.Hide })
    ).resolves.toBe(true);

    engagement.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      clearUserEngagement({ userId, targetUserId, type: UserEngagementType.Hide })
    ).resolves.toBe(false);
  });
});

// 868kurkd0. These toggles used to end in `userFollowsCache.refresh`, which refetches
// the user's ENTIRE follow set from the primary — 19,224 buffers and ~100 ms for a
// user with 130k follows, measured on prod, per click. The delta is known here, so
// the entry is rewritten in place; the refetch stays as the fallback for the cases
// where it is NOT known, because a missing entry is repopulated by the next reader
// from the replica, which can be behind the write that just happened.
//
// Every assertion below applies the updater to a fixture rather than checking that
// the cache was touched: an updater with the sign flipped passes a bare call check
// and leaves the user following someone they just unfollowed.
describe('the follow set is maintained by delta, not refetched', () => {
  const spies = () => ({
    update: vi.spyOn(userFollowsCache, 'update').mockResolvedValue(true),
    refresh: vi.spyOn(userFollowsCache, 'refresh').mockResolvedValue(undefined),
  });
  const applied = (update: ReturnType<typeof spies>['update'], follows: number[]) =>
    update.mock.calls[0][1]({ userId, follows });

  it('unfollowing removes the target from the cached set', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });
    const { update, refresh } = spies();

    await toggleFollowUser({ userId, targetUserId });

    expect(applied(update, [targetUserId, 7])).toEqual({ userId, follows: [7] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('following from nothing adds the target', async () => {
    const { update, refresh } = spies();

    await toggleFollowUser({ userId, targetUserId });

    expect(applied(update, [7])).toEqual({ userId, follows: [7, targetUserId] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('following someone hidden adds the target once the Hide is converted', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    const { update } = spies();

    await toggleFollowUser({ userId, targetUserId });

    expect(applied(update, [])).toEqual({ userId, follows: [targetUserId] });
  });

  it('a follow that lost the row to a Block REMOVES rather than adds', async () => {
    // `updateMany` matching nothing means the Hide is gone — replaced by a Block —
    // so no follow was established. Adding the id here is the cache half of the
    // 868kumcfc lie: the user is told they follow someone they do not.
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    engagement.updateMany.mockResolvedValue({ count: 0 });
    const { update } = spies();

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(applied(update, [targetUserId, 7])).toEqual({ userId, follows: [7] });
  });

  it('a create that lost the PK to a Block REMOVES rather than adds', async () => {
    engagement.create.mockRejectedValue(p2002());
    engagement.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ type: 'Block' });
    const { update } = spies();

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);

    expect(applied(update, [targetUserId])).toEqual({ userId, follows: [] });
  });

  it('hiding drops the target from the follow set', async () => {
    const { update, refresh } = spies();

    await hide(true);

    expect(applied(update, [targetUserId, 7])).toEqual({ userId, follows: [7] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('un-hiding drops it too when a Hide was actually removed', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    engagement.deleteMany.mockResolvedValue({ count: 1 });
    const { update, refresh } = spies();

    await hide(false);

    expect(applied(update, [targetUserId])).toEqual({ userId, follows: [] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('un-hiding that matched NO row re-derives instead of guessing', async () => {
    // The pair is not the Hide this call read. It may hold a Follow, and asserting
    // `following: false` over one would drop a live follow from the cache for a day.
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });
    engagement.deleteMany.mockResolvedValue({ count: 0 });
    const { update, refresh } = spies();

    await hide(false);

    expect(update).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(userId);
  });

  it('falls back to the refetch when there is no cached entry to correct', async () => {
    const refresh = vi.spyOn(userFollowsCache, 'refresh').mockResolvedValue(undefined);
    vi.spyOn(userFollowsCache, 'update').mockResolvedValue(false);

    await toggleFollowUser({ userId, targetUserId });

    // Without this the entry stays absent and the next reader rebuilds it from the
    // REPLICA — the one read that can miss the write this call just made.
    expect(refresh).toHaveBeenCalledWith(userId);
  });
});
