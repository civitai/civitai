import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlockCheckService from '~/server/services/block-check.service';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

const getCommentsInfinite = vi.fn(async () => null);
const getCommentsThreadDetails2 = vi.fn(async () => null);
const getCommentCount = vi.fn(async () => 0);
const upsertComment = vi.fn(async () => ({ id: 1 }));
const getComment = vi.fn(async () => ({ id: 5, threadId: 70, user: { id: 9 } }));
const getCommentThreadBounty = vi.fn(async () => null);
const getCommentThreadCrucibleId = vi.fn<() => Promise<number | null>>(async () => null);
const getCommentCrucibleId = vi.fn<() => Promise<number | null>>(async () => null);

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getCommentsInfinite: (...args: unknown[]) => getCommentsInfinite(...(args as [])),
  getCommentsThreadDetails2: (...args: unknown[]) => getCommentsThreadDetails2(...(args as [])),
  getCommentCount: (...args: unknown[]) => getCommentCount(...(args as [])),
  upsertComment: (...args: unknown[]) => upsertComment(...(args as [])),
  getComment: (...args: unknown[]) => getComment(...(args as [])),
  getCommentThreadBounty: (...args: unknown[]) => getCommentThreadBounty(...(args as [])),
  getCommentThreadCrucibleId: (...args: unknown[]) => getCommentThreadCrucibleId(...(args as [])),
  getCommentCrucibleId: (...args: unknown[]) => getCommentCrucibleId(...(args as [])),
  isViewerContentOwner: vi.fn(async () => false),
  toggleHideComment: vi.fn(async () => ({ id: 55 })),
  togglePinComment: vi.fn(async () => ({ id: 55 })),
}));

vi.mock('~/server/services/block-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCheckService>()),
  getContentOwnerIdForComment: vi.fn(async () => ({ ownerId: CREATOR, hidden: false })),
}));

const blockedBy = { ids: [] as number[] };
const blocked = { ids: [] as number[] };
const preference = (ids: () => number[]) => ({
  getCached: vi.fn(async () => ids().map((id) => ({ id }))),
});
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: preference(() => []),
  BlockedUsers: preference(() => blocked.ids),
  BlockedByUsers: preference(() => blockedBy.ids),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));

const {
  getCommentsInfiniteHandler,
  getCommentsThreadDetailsHandler,
  getCommentCountV2Handler,
  upsertCommentV2Handler,
  getCommentHandler,
  toggleHideCommentHandler,
  togglePinnedCommentHandler,
} = await import('../commentv2.controller');

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
  takenDownAt: null,
  ...over,
});

const HANDLERS = [
  ['getInfinite', getCommentsInfiniteHandler, getCommentsInfinite],
  ['getThreadDetails', getCommentsThreadDetailsHandler, getCommentsThreadDetails2],
  ['getCount', getCommentCountV2Handler, getCommentCount],
  ['upsert', upsertCommentV2Handler, upsertComment],
] as unknown as Array<
  [string, (a: { ctx: never; input: never }) => Promise<unknown>, { mock: { calls: unknown[] } }]
>;

describe.each(HANDLERS)('crucible comments visibility: %s', (_name, handler, service) => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockedBy.ids = [];
    blocked.ids = [];
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
  });

  const call = (ctx: unknown) => handler({ ctx: ctx as never, input: input as never });

  it('refuses a viewer who blocked the creator', async () => {
    blocked.ids = [CREATOR];
    await expect(call(ctxFor({ id: 9 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.mock.calls.length).toBe(0);
  });

  it('serves the thread of a crucible the viewer can open', async () => {
    await call(ctxFor({ id: 9 }));
    expect(service.mock.calls.length).toBe(1);
  });

  it('serves an adult-level crucible off the green site (negative control)', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ nsfwLevel: 16 }));
    await call(ctxFor({ id: 9 }, { isGreen: false }));
    expect(service.mock.calls.length).toBe(1);
  });

  it.each([
    ['missing', null, false],
    ['still being scanned', crucibleRow({ ingestion: 'Pending' }), false],
    ['adult on the green site', crucibleRow({ nsfwLevel: 16 }), true],
    ['taken down by a moderator', crucibleRow({ takenDownAt: new Date() }), false],
  ])('refuses the thread of a crucible that is %s', async (_label, row, isGreen) => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(row);
    await expect(call(ctxFor({ id: 9 }, { isGreen }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(service.mock.calls.length).toBe(0);
  });

  it('refuses a viewer whom the creator blocked', async () => {
    blockedBy.ids = [CREATOR];
    await expect(call(ctxFor({ id: 9 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.mock.calls.length).toBe(0);
  });

  it('still lets a moderator through a block and a pending scan', async () => {
    blockedBy.ids = [CREATOR];
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ ingestion: 'Pending' }));
    await call(ctxFor({ id: 1, isModerator: true }));
    expect(service.mock.calls.length).toBe(1);
  });
});

// A reply is addressed as entity `comment`, so its crucible is found through the parent's thread.
describe.each(HANDLERS)('crucible reply visibility: %s', (_name, handler, service) => {
  const reply = { entityType: 'comment', entityId: 55 };
  const call = (ctx: unknown) => handler({ ctx: ctx as never, input: reply as never });

  beforeEach(() => {
    vi.clearAllMocks();
    blockedBy.ids = [];
    blocked.ids = [];
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    // A live parent, so a refusal can only come from the crucible gate.
    dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: false });
    getCommentCrucibleId.mockResolvedValue(17);
  });

  it('refuses the replies of a taken-down crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ takenDownAt: new Date() }));
    await expect(call(ctxFor({ id: 9 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.mock.calls.length).toBe(0);
  });

  // A reply upsert also looks up its parent, which these mocks don't serve; the read paths show
  // the gate lets a visible crucible through.
  const reads = _name !== 'upsert';

  it.runIf(reads)('serves the replies of a crucible the viewer can open', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
    await call(ctxFor({ id: 9 }));
    expect(service.mock.calls.length).toBe(1);
  });

  it.runIf(reads)('serves a moderator the replies of a taken-down crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ takenDownAt: new Date() }));
    await call(ctxFor({ id: 1, isModerator: true }));
    expect(service.mock.calls.length).toBe(1);
  });
});

describe.each([
  ['hide', () => toggleHideCommentHandler],
  ['pin', () => togglePinnedCommentHandler],
] as const)('the owner can %s a comment on their crucible', (_name, handlerOf) => {
  const call = () =>
    handlerOf()({ ctx: ctxFor({ id: CREATOR }) as never, input: { id: 55 } as never });

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    dbMock.dbWrite.commentV2.findUnique.mockResolvedValue({ tosViolation: false });
    getCommentCrucibleId.mockResolvedValue(17);
  });

  it('while it is up (control)', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
    await expect(call()).resolves.toMatchObject({ id: 55 });
  });

  it('not once a moderator took it down', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ takenDownAt: new Date() }));
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('not when its creator blocked the one acting', async () => {
    blockedBy.ids = [CREATOR];
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
    await expect(
      handlerOf()({ ctx: ctxFor({ id: 9 }) as never, input: { id: 55 } as never })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    blockedBy.ids = [];
  });

  it('a moderator still can on a taken-down crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ takenDownAt: new Date() }));
    await expect(
      handlerOf()({
        ctx: ctxFor({ id: 1, isModerator: true }) as never,
        input: { id: 55 } as never,
      })
    ).resolves.toMatchObject({ id: 55 });
  });
});

describe('getCommentHandler on a crucible comment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockedBy.ids = [];
    getCommentThreadCrucibleId.mockResolvedValue(17);
    getCommentCrucibleId.mockResolvedValue(null);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow());
  });

  const read = (ctx: unknown) =>
    getCommentHandler({ ctx: ctx as never, input: { id: 5 } as never });

  it('resolves the crucible from the comment thread', async () => {
    await read(ctxFor({ id: 9 }));
    expect(getCommentThreadCrucibleId).toHaveBeenCalledWith(70);
  });

  it.each([
    ['blocked by the creator', () => (blockedBy.ids = [CREATOR])],
    [
      'hidden by its scan',
      () =>
        dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ ingestion: 'Pending' })),
    ],
  ])('refuses a comment on a crucible that is %s', async (_label, arrange) => {
    arrange();
    await expect(read(ctxFor({ id: 9 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets a moderator read it, without resolving the crucible', async () => {
    blockedBy.ids = [CREATOR];
    await expect(read(ctxFor({ id: 1, isModerator: true }))).resolves.toBeTruthy();
    expect(getCommentThreadCrucibleId).not.toHaveBeenCalled();
  });

  it('finds the crucible of a reply whose thread has no root, through its chain', async () => {
    getCommentThreadCrucibleId.mockResolvedValue(null);
    getCommentCrucibleId.mockResolvedValue(17);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow({ takenDownAt: new Date() }));
    await expect(read(ctxFor({ id: 9 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getCommentCrucibleId).toHaveBeenCalledWith(5);
  });

  it('does not gate a comment outside any crucible', async () => {
    getCommentThreadCrucibleId.mockResolvedValue(null);
    blockedBy.ids = [CREATOR];
    await expect(read(ctxFor({ id: 9 }))).resolves.toBeTruthy();
  });
});
