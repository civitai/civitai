import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { toggleHiddenSchema } from '~/server/schema/user-preferences.schema';
import { userFollowsCache } from '~/server/redis/caches';

const { declinePlacementsOnBlock } = vi.hoisted(() => ({
  declinePlacementsOnBlock: vi.fn(async () => undefined),
}));

// Bare factory rather than a spread of the original: `user-preferences.service`
// reaches this module ONLY through the dynamic import inside
// `cascadeBlockToPlacements`, and only for this one export. Spreading the real
// module would pull the escrow -> Buzz -> prom chain into the test graph, which
// survives today only because setup.ts happens to mock every link — the trap
// documented at the top of src/__tests__/setup.ts.
vi.mock('~/server/services/placement-moderation.service', () => ({
  declinePlacementsOnBlock,
}));

import {
  toggleHidden,
  BlockedUsers,
  BlockedByUsers,
} from '~/server/services/user-preferences.service';

const userId = 42;
const targetUserId = 99;
const engagement = dbMock.dbWrite.userEngagement;
const where = { userId_targetUserId: { userId, targetUserId } };

const block = (hidden?: boolean) =>
  toggleHidden({ kind: 'blockedUser', data: [{ id: targetUserId }], hidden, userId });

beforeEach(() => {
  vi.clearAllMocks();
  // The cache test spies on module-scope objects. Without a restore those spies
  // outlive it and silently cover every test declared after it.
  vi.restoreAllMocks();
  // `mockResolvedValue`, not `...Once`: `clearAllMocks` is `mockClear`, which does
  // not drain a queued once-implementation, so a test that threw before reaching
  // `findUnique` would leak its fixture into the next one — invisibly, because the
  // drained fallback (`null`) is itself a valid fixture here.
  engagement.findUnique.mockResolvedValue(null);
  engagement.upsert.mockResolvedValue({});
  engagement.deleteMany.mockResolvedValue({ count: 0 });
});

// The bug this pins: `toggleHidden` dropped `hidden` on the way to
// `toggleBlockUser`, so the service could only flip whatever row it found. A
// client holding a stale block list therefore sent "block" and got an UNBLOCK,
// and the UI reported success either way.
//
// These assert through `toggleHidden` — the exported entry the router calls —
// NOT `toggleBlockUser`. That is load-bearing: a test calling the inner
// function supplies `setTo` itself and passes against the broken code. Please
// keep them at this level.
describe('toggleHidden kind=blockedUser — honours the caller intent', () => {
  it('hidden=true on an ALREADY blocked user leaves the block standing', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await block(true);

    expect(engagement.deleteMany).not.toHaveBeenCalled();
    expect(engagement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where, update: { type: 'Block' } })
    );
  });

  it('hidden=false on a blocked user removes the block', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await block(false);

    expect(engagement.upsert).not.toHaveBeenCalled();
    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Block' },
    });
  });

  it('hidden=true with no engagement establishes the block', async () => {
    await block(true);

    expect(engagement.upsert).toHaveBeenCalledWith({
      where,
      create: { userId, targetUserId, type: 'Block' },
      update: { type: 'Block' },
    });
  });

  it('hidden=false with no engagement never creates one — an unblock must not block', async () => {
    await block(false);

    expect(engagement.upsert).not.toHaveBeenCalled();
    // Assert the unblock still took its own path, so deleting the else-branch
    // outright cannot pass this test on the negative alone.
    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Block' },
    });
  });

  it('hidden=true over an existing Follow promotes the row to Block', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    await block(true);

    expect(engagement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { type: 'Block' } })
    );
  });

  it('hidden=false over an existing Follow leaves that Follow alone', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Follow' });

    await block(false);

    expect(engagement.upsert).not.toHaveBeenCalled();
    // The `type` filter is what protects the row, so assert the filter itself —
    // an unscoped deleteMany would pass a "was it called" check and still take
    // the Follow with it.
    expect(engagement.deleteMany).toHaveBeenCalledWith({
      where: { userId, targetUserId, type: 'Block' },
    });
  });

  it('hidden omitted still flips, so callers that send no intent are unchanged', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await block(undefined);

    expect(engagement.deleteMany).toHaveBeenCalled();
    expect(engagement.upsert).not.toHaveBeenCalled();
  });

  it('hidden omitted with no engagement blocks — the fallback must work both ways', async () => {
    await block(undefined);

    // Without this the suite cannot tell `setTo ?? !alreadyBlocked` from
    // `setTo === true`: every other omitted-intent case starts from a Block row,
    // where both forms happen to agree. That mutant also makes the `findUnique`
    // read dead code.
    expect(engagement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { userId, targetUserId, type: 'Block' } })
    );
  });
});

// Without these the writes are correct and invisible: every read path serves the
// stale cached list until the hash TTL expires.
describe('toggleHidden kind=blockedUser — cache invalidation', () => {
  it('refreshes both projections of the row plus the follows cache', async () => {
    const blocked = vi.spyOn(BlockedUsers, 'refreshCache').mockResolvedValue(undefined);
    const blockedBy = vi.spyOn(BlockedByUsers, 'refreshCache').mockResolvedValue(undefined);
    const follows = vi.spyOn(userFollowsCache, 'refresh').mockResolvedValue(undefined);

    await block(true);

    // One row, two projections: the blocker's list is keyed on `userId`, the
    // target's "blocked by" list on `targetUserId`.
    expect(blocked).toHaveBeenCalledWith({ userId });
    expect(blockedBy).toHaveBeenCalledWith({ userId: targetUserId });
    expect(follows).toHaveBeenCalledWith(userId);
  });

  it('refreshes them on an unblock too, not only on a block', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });
    const blocked = vi.spyOn(BlockedUsers, 'refreshCache').mockResolvedValue(undefined);
    const blockedBy = vi.spyOn(BlockedByUsers, 'refreshCache').mockResolvedValue(undefined);

    await block(false);

    // Gating the refreshes on `blocking` would leave a lifted block invisible to
    // every read path until the hash TTL — the stale list is what caused this bug
    // in the first place.
    expect(blocked).toHaveBeenCalledWith({ userId });
    expect(blockedBy).toHaveBeenCalledWith({ userId: targetUserId });
  });
});

describe('toggleHidden kind=blockedUser — placement cascade', () => {
  it('runs in both directions when the block is established', async () => {
    await block(true);

    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: userId,
      placerId: targetUserId,
      waiveFee: true,
    });
    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: targetUserId,
      placerId: userId,
      waiveFee: false,
    });
  });

  it('cascades even when the user is ALREADY blocked', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await block(true);

    // `declinePlacementsOnBlock` caps at 200 pending rows per direction and
    // swallows its own failures, so blocking again is the only user-reachable
    // retry. Gating this on `!alreadyBlocked` would silently remove it.
    //
    // The count alone does not prove that — a first-time block also produces 2,
    // one per direction — so assert both legs and let the `findUnique` fixture
    // above carry the "already blocked" part.
    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: userId,
      placerId: targetUserId,
      waiveFee: true,
    });
    expect(declinePlacementsOnBlock).toHaveBeenCalledWith({
      ownerId: targetUserId,
      placerId: userId,
      waiveFee: false,
    });
    expect(declinePlacementsOnBlock).toHaveBeenCalledTimes(2);
  });

  it('runs AFTER the block is committed, which is the precondition it asserts', async () => {
    await block(true);

    expect(declinePlacementsOnBlock.mock.invocationCallOrder[0]).toBeGreaterThan(
      engagement.upsert.mock.invocationCallOrder[0]
    );
  });

  it('never fails the block when a cascade leg throws', async () => {
    declinePlacementsOnBlock.mockRejectedValueOnce(new Error('buzz outage'));

    await expect(block(true)).resolves.toEqual({ added: [], removed: [] });

    // The block is the protection; the refunds are recoverable by the expiry job.
    // The second direction must still be attempted after the first throws.
    expect(engagement.upsert).toHaveBeenCalled();
    expect(declinePlacementsOnBlock).toHaveBeenCalledTimes(2);
  });

  it('does not run on an unblock', async () => {
    engagement.findUnique.mockResolvedValue({ type: 'Block' });

    await block(false);

    expect(declinePlacementsOnBlock).not.toHaveBeenCalled();
  });
});

describe('toggleHidden kind=blockedUser — guards', () => {
  it('refuses to block yourself', async () => {
    await expect(
      toggleHidden({ kind: 'blockedUser', data: [{ id: userId }], hidden: true, userId })
    ).rejects.toThrow('Cannot block yourself');
    expect(engagement.upsert).not.toHaveBeenCalled();
  });

  it('refuses to block the civitai account', async () => {
    await expect(
      toggleHidden({ kind: 'blockedUser', data: [{ id: -1 }], hidden: true, userId })
    ).rejects.toThrow('Cannot block civitai account');
    expect(engagement.upsert).not.toHaveBeenCalled();
  });
});

// The last link in the chain. Drop or rename `hidden` on this schema member and
// the intent never reaches the service, the original bug is back, and every test
// above still passes because they build their input by hand.
describe('toggleHiddenSchema', () => {
  it('carries hidden through the blockedUser member', () => {
    const parsed = toggleHiddenSchema.parse({
      kind: 'blockedUser',
      data: [{ id: targetUserId }],
      hidden: false,
    });

    expect(parsed).toMatchObject({ kind: 'blockedUser', hidden: false });
  });
});
