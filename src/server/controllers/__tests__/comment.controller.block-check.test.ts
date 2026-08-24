import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Block enforcement on the legacy model-comment write path (`comment.upsert`).
 *
 * The handler's `ctx.ownerId` is the COMMENT's author — the caller themselves on a create — so the
 * check it fed resolved to "am I blocked by me", which is never true: the model owner's block was
 * never evaluated and a blocked user could post on the model they were blocked from. Enforcement
 * now resolves the model owner (and, for a reply, the parent author) through the shared guard, on
 * edits as well as creates.
 */

const {
  amIBlockedByUser,
  mockCreateOrUpdateComment,
  mockHasEntityAccess,
  throwOnBlockedCommentContent,
} = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  throwOnBlockedCommentContent: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  mockCreateOrUpdateComment: vi.fn(
    async (..._a: unknown[]): Promise<unknown> => ({
      id: 1,
      modelId: 10,
      content: 'hi',
      nsfw: false,
    })
  ),
  mockHasEntityAccess: vi.fn(async (..._a: unknown[]): Promise<unknown> => [{ hasAccess: true }]),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedCommentContent }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/rewards', () => ({ reportAcceptedReward: { apply: vi.fn() } }));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: (...a: unknown[]) => mockHasEntityAccess(...(a as [])),
}));
vi.mock('~/server/services/comment.service', () => ({
  createOrUpdateComment: (...a: unknown[]) => mockCreateOrUpdateComment(...(a as [])),
  deleteCommentById: vi.fn(),
  getCommentById: vi.fn(),
  getCommentReactions: vi.fn(),
  getComments: vi.fn(),
  getPinnedComments: vi.fn(),
  toggleHideComment: vi.fn(),
  togglePinComment: vi.fn(),
  updateCommentById: vi.fn(),
  updateCommentReportStatusByReason: vi.fn(),
}));

import { upsertCommentHandler } from '../comment.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDb = dbMock.dbRead;
const REQUEST_MODEL_OWNER = 100;
const STORED_MODEL_OWNER = 101;
const PARENT_AUTHOR = 55;
const COMMENTER = 7;
const REQUEST_MODEL = 10;
const STORED_MODEL = 11;
const PARENT_ID = 9;
const COMMENT_ID = 5;

/**
 * Keyed on the id asked for, not on call order. The handler's own version-access lookup and the
 * guard's owner lookup are both `model.findUnique` on the same table, so a `…Once` queue would be
 * consumed by whichever ran first and the guard would silently resolve nobody.
 */
function arrange({ storedComment = false }: { storedComment?: boolean } = {}) {
  const modelOwners: Record<number, number> = {
    [REQUEST_MODEL]: REQUEST_MODEL_OWNER,
    [STORED_MODEL]: STORED_MODEL_OWNER,
  };
  mockDb.model.findUnique.mockImplementation(async (args: unknown) => {
    const id = (args as { where: { id: number } }).where.id;
    return modelOwners[id] ? { id, userId: modelOwners[id], modelVersions: [{ id: 1 }] } : null;
  });
  mockDb.comment.findUnique.mockImplementation(async (args: unknown) => {
    const id = (args as { where: { id: number } }).where.id;
    if (id === PARENT_ID) return { userId: PARENT_AUTHOR, modelId: REQUEST_MODEL };
    // The comment being edited lives on a DIFFERENT model than the request names, so an assertion
    // about the stored owner cannot be satisfied by the requested one.
    if (id === COMMENT_ID && storedComment) return { modelId: STORED_MODEL, parentId: null };
    return null;
  });
}

function ctx({ isModerator = false }: { isModerator?: boolean } = {}) {
  return {
    user: { id: COMMENTER, isModerator },
    ownerId: COMMENTER,
    locked: false,
    track: { comment: vi.fn(), commentEvent: vi.fn() },
  } as unknown as Parameters<typeof upsertCommentHandler>[0]['ctx'];
}

const baseInput = {
  modelId: REQUEST_MODEL,
  content: '<p>hello</p>',
} as Parameters<typeof upsertCommentHandler>[0]['input'];

const blockedBy = (...userIds: number[]) =>
  amIBlockedByUser.mockImplementation(async (args) =>
    userIds.includes((args as { targetUserId: number }).targetUserId)
  );

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
  mockHasEntityAccess.mockResolvedValue([{ hasAccess: true }]);
  throwOnBlockedCommentContent.mockResolvedValue(undefined);
  arrange();
});

/**
 * The blocklist guard is mocked in every suite that reaches a call site, so nothing observed
 * that the wiring existed: deleting the call, or hardcoding `{ isModerator: true }` here, left
 * the whole workspace green. The second is the production state 868kw2f8y was filed about.
 */
describe('upsertCommentHandler - blocklist guard wiring', () => {
  it('runs the guard once on the submitted content, with the caller moderator flag', async () => {
    await upsertCommentHandler({ ctx: ctx(), input: baseInput });
    expect(throwOnBlockedCommentContent).toHaveBeenCalledTimes(1);
    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('<p>hello</p>', {
      isModerator: false,
    });
  });

  it('forwards a moderator through to the guard rather than deciding locally', async () => {
    await upsertCommentHandler({ ctx: ctx({ isModerator: true }), input: baseInput });
    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('<p>hello</p>', {
      isModerator: true,
    });
  });

  // Ordering: a guard running AFTER the write would leave the phishing comment in the table
  // and merely fail the request.
  it('rejects before writing when the guard throws', async () => {
    throwOnBlockedCommentContent.mockRejectedValueOnce(new Error('blocked'));
    await expect(upsertCommentHandler({ ctx: ctx(), input: baseInput })).rejects.toThrow();
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });
});

describe('upsertCommentHandler — block enforcement', () => {
  it('throws and never writes when the commenter is blocked by the model owner', async () => {
    blockedBy(REQUEST_MODEL_OWNER);

    await expect(upsertCommentHandler({ ctx: ctx(), input: baseInput })).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: REQUEST_MODEL_OWNER,
    });
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('lets a non-blocked commenter write, having actually asked about the model owner', async () => {
    await upsertCommentHandler({ ctx: ctx(), input: baseInput });

    // The control for the negative case above: same setup, block flag flipped, write happens.
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: REQUEST_MODEL_OWNER,
    });
    expect(mockCreateOrUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('throws and never writes when a blocked user edits a comment written before the block', async () => {
    // Only the model the comment is STORED on blocks, so this fails if the edit trusts the request.
    arrange({ storedComment: true });
    blockedBy(STORED_MODEL_OWNER);

    await expect(
      upsertCommentHandler({ ctx: ctx(), input: { ...baseInput, id: COMMENT_ID } })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: STORED_MODEL_OWNER,
    });
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('lets a non-blocked author edit', async () => {
    arrange({ storedComment: true });

    await upsertCommentHandler({ ctx: ctx(), input: { ...baseInput, id: COMMENT_ID } });
    expect(mockCreateOrUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('checks the parent author on a reply, not only the model owner', async () => {
    blockedBy(PARENT_AUTHOR);

    await expect(
      upsertCommentHandler({ ctx: ctx(), input: { ...baseInput, parentId: PARENT_ID } })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: PARENT_AUTHOR,
    });
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('exempts moderators', async () => {
    blockedBy(REQUEST_MODEL_OWNER);

    await upsertCommentHandler({ ctx: ctx({ isModerator: true }), input: baseInput });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateComment).toHaveBeenCalledTimes(1);
  });
});
