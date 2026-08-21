import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { HiddenUsers, toggleHidden } from '~/server/services/user-preferences.service';
import { toggleFollowUser, toggleHideUser } from '~/server/services/user.service';

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

const hide = (hidden?: boolean) =>
  toggleHidden({ kind: 'user', data: [{ id: targetUserId }], hidden, userId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // `mockResolvedValue`, not `...Once` — `clearAllMocks` is `mockClear` and does not
  // drain a queued once-implementation, so a test that threw early would leak its
  // fixture into the next one.
  engagement.findUnique.mockResolvedValue(null);
  engagement.create.mockResolvedValue({});
  engagement.deleteMany.mockResolvedValue({ count: 0 });
  // A row matched by default, so a test that means "nothing matched" has to say so.
  engagement.updateMany.mockResolvedValue({ count: 1 });
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
    'toggleHideUser issues no PK-addressed write over a %s row',
    async (type) => {
      engagement.findUnique.mockResolvedValue({ type });

      await toggleHideUser({ userId, targetUserId });

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
    engagement.updateMany.mockResolvedValue({ count: 0 });
    engagement.create.mockRejectedValue(p2002());

    // Nothing matched the update and the insert conflicts with the block — the
    // intended end state either way, so the toggle must not 500 on a safety
    // control.
    await expect(hide(true)).resolves.toEqual({ added: [], removed: [] });
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

// 868kumcfc. The OTHER `toggleHideUser` — same name, different file, opposite
// failure: over a Block it matched no branch, wrote nothing, and returned falsy, so
// the caller logged the hide as a removal.
describe('toggleHideUser (user.service) — reports what it did', () => {
  it('reports a blocked user as hidden without touching the row', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await expect(toggleHideUser({ userId, targetUserId })).resolves.toBe(true);

    expect(engagement.updateMany).not.toHaveBeenCalled();
    expect(engagement.deleteMany).not.toHaveBeenCalled();
    expect(engagement.create).not.toHaveBeenCalled();
  });

  it('hiding a followed user reports HIDDEN, not removed', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    // The old branch converted the row and returned false, so the tracking event
    // recorded a `Delete` for a write that established a Hide.
    await expect(toggleHideUser({ userId, targetUserId })).resolves.toBe(true);

    expect(engagement.updateMany).toHaveBeenCalledWith({
      where: { ...scoped, type: { notIn: ['Block'] } },
      data: { type: 'Hide' },
    });
  });

  it('un-hiding removes a Hide and only a Hide', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Hide' });

    await expect(toggleHideUser({ userId, targetUserId })).resolves.toBe(false);

    expect(engagement.deleteMany).toHaveBeenCalledWith({ where: { ...scoped, type: 'Hide' } });
  });

  // The dominant real path — hiding someone you have no engagement with — and the
  // one every other test in this describe routes past, because they all supply a
  // row and leave `updateMany` matching it.
  it('hiding a user with no engagement creates the row', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });

    await expect(toggleHideUser({ userId, targetUserId })).resolves.toBe(true);

    expect(engagement.create).toHaveBeenCalledWith({
      data: { type: 'Hide', targetUserId, userId },
    });
  });

  it('survives the create losing to a Block that arrived in between', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });
    engagement.create.mockRejectedValue(p2002());

    await expect(toggleHideUser({ userId, targetUserId })).resolves.toBe(true);
  });

  it('still surfaces a create failure that is not the conflict', async () => {
    engagement.updateMany.mockResolvedValue({ count: 0 });
    engagement.create.mockRejectedValue(new Error('connection terminated'));

    // Control for the test above: `catch(() => {})` passes that one and swallows
    // every real write failure with it, reporting a hide that never happened.
    await expect(toggleHideUser({ userId, targetUserId })).rejects.toThrow('connection terminated');
  });
});

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
  it('reports NO follow when a Block won the insert race', async () => {
    engagement.create.mockRejectedValue(p2002());
    engagement.findUnique
      .mockResolvedValueOnce(null) // the read that chose the create path
      .mockResolvedValueOnce({ type: 'Block' }); // what actually holds the pair

    await expect(toggleFollowUser({ userId, targetUserId })).resolves.toBe(false);
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

  it('refreshes HiddenUsers when toggleHideUser writes the Hide', async () => {
    const hidden = vi.spyOn(HiddenUsers, 'refreshCache').mockResolvedValue(undefined);

    await toggleHideUser({ userId, targetUserId });

    expect(hidden).toHaveBeenCalledWith({ userId });
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
    engagement.updateMany.mockResolvedValue({ count: 0 });
    engagement.create.mockRejectedValue(p2002());

    await hide(true);

    // A `while` here would loop forever against a standing Block — and a pure
    // microtask loop starves the macrotask queue, so vitest's setTimeout-based
    // testTimeout never fires and the run hangs with nothing to read.
    expect(engagement.updateMany).toHaveBeenCalledTimes(2);
    expect(engagement.create).toHaveBeenCalledTimes(2);
  });
});
