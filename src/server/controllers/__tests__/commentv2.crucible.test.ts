import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

const getCommentsInfinite = vi.fn(async () => null);
const toggleLockCommentsThread = vi.fn(async () => ({ locked: true }));
const canToggleThreadLock = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getCommentsInfinite: (...args: unknown[]) => getCommentsInfinite(...(args as [])),
  toggleLockCommentsThread: (...args: unknown[]) => toggleLockCommentsThread(...(args as [])),
  canToggleThreadLock: (...args: unknown[]) => canToggleThreadLock(...args),
  isViewerContentOwner: vi.fn(async () => false),
}));

const blockedBy = { ids: [] as number[] };
const preference = (ids: () => number[]) => ({
  getCached: vi.fn(async () => ids().map((id) => ({ id }))),
});
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: preference(() => []),
  BlockedUsers: preference(() => []),
  BlockedByUsers: preference(() => blockedBy.ids),
}));

const { getCommentsInfiniteHandler, toggleLockThreadDetailsHandler } = await import(
  '../commentv2.controller'
);

const CREATOR = 4;
const input = { entityType: 'crucible', entityId: 17 } as never;
const ctxFor = (
  user: { id: number; isModerator?: boolean } | undefined,
  features: { isGreen?: boolean } = {}
) => ({ user, features } as never);

const crucibleRow = (over: Record<string, unknown> = {}) => ({
  userId: CREATOR,
  nsfwLevel: 1,
  textNsfw: false,
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
  ...over,
});

describe('crucible comments visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockedBy.ids = [];
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
  });

  it('serves the thread of a crucible the viewer can open', async () => {
    await getCommentsInfiniteHandler({
      ctx: ctxFor({ id: 9 }),
      input: { ...(input as object) } as never,
    });
    expect(getCommentsInfinite).toHaveBeenCalled();
  });

  it.each([
    ['missing', null, { id: 9 }],
    ['still being scanned', crucibleRow({ ingestion: 'Pending' }), { id: 9 }],
    ['adult on the green site', crucibleRow({ nsfwLevel: 16 }), { id: 9, green: true }],
  ])('refuses the thread of a crucible that is %s', async (_label, row, viewer) => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(row);
    await expect(
      getCommentsInfiniteHandler({
        ctx: ctxFor({ id: viewer.id }, { isGreen: 'green' in viewer }),
        input,
      } as never)
    ).rejects.toThrow();
    expect(getCommentsInfinite).not.toHaveBeenCalled();
  });

  it('refuses a viewer whom the creator blocked', async () => {
    blockedBy.ids = [CREATOR];
    await expect(getCommentsInfiniteHandler({ ctx: ctxFor({ id: 9 }), input })).rejects.toThrow();
    expect(getCommentsInfinite).not.toHaveBeenCalled();
  });

  it('still lets a moderator through a block and a pending scan', async () => {
    blockedBy.ids = [CREATOR];
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ ingestion: 'Pending' }));
    await getCommentsInfiniteHandler({ ctx: ctxFor({ id: 1, isModerator: true }), input });
    expect(getCommentsInfinite).toHaveBeenCalled();
  });
});

describe('toggleLockThreadDetailsHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks when the policy allows the caller', async () => {
    canToggleThreadLock.mockResolvedValueOnce(true);
    await toggleLockThreadDetailsHandler({ ctx: ctxFor({ id: CREATOR }), input } as never);

    expect(canToggleThreadLock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CREATOR, isModerator: false, entityType: 'crucible' })
    );
    expect(toggleLockCommentsThread).toHaveBeenCalledWith(input);
  });

  it('refuses, and locks nothing, when the policy says no', async () => {
    canToggleThreadLock.mockResolvedValueOnce(false);
    await expect(
      toggleLockThreadDetailsHandler({ ctx: ctxFor({ id: 9 }), input } as never)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(toggleLockCommentsThread).not.toHaveBeenCalled();
  });
});
