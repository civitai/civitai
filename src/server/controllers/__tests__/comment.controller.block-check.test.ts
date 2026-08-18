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

const { amIBlockedByUser, mockCreateOrUpdateComment, mockHasEntityAccess } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
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
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
}));
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
const MODEL_OWNER = 100;
const PARENT_AUTHOR = 55;
const COMMENTER = 7;
const MODEL_ID = 10;

// The model lookup the handler makes for version access — distinct from the `findMany` the block
// resolver uses, so neither can stand in for the other.
function modelHasOneVersion() {
  mockDb.model.findUnique.mockResolvedValue({ id: MODEL_ID, modelVersions: [{ id: 1 }] });
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
  modelId: MODEL_ID,
  content: '<p>hello</p>',
} as Parameters<typeof upsertCommentHandler>[0]['input'];

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
  mockHasEntityAccess.mockResolvedValue([{ hasAccess: true }]);
  modelHasOneVersion();
  mockDb.model.findMany.mockResolvedValue([{ userId: MODEL_OWNER }]);
});

describe('upsertCommentHandler — block enforcement', () => {
  it('throws and never writes when the commenter is blocked by the model owner', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await expect(upsertCommentHandler({ ctx: ctx(), input: baseInput })).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: MODEL_OWNER,
    });
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('lets a non-blocked commenter write, having actually asked about the model owner', async () => {
    await upsertCommentHandler({ ctx: ctx(), input: baseInput });

    // The control for the negative case above: same setup, block flag flipped, write happens.
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: MODEL_OWNER,
    });
    expect(mockCreateOrUpdateComment).toHaveBeenCalledTimes(1);
  });

  it('throws and never writes when a blocked user edits a comment written before the block', async () => {
    mockDb.comment.findUnique.mockResolvedValue({ modelId: MODEL_ID, parentId: null });
    amIBlockedByUser.mockResolvedValue(true);

    await expect(
      upsertCommentHandler({ ctx: ctx(), input: { ...baseInput, id: 5 } })
    ).rejects.toThrow();
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('checks the parent author on a reply, not only the model owner', async () => {
    mockDb.comment.findMany.mockResolvedValue([{ userId: PARENT_AUTHOR }]);
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === PARENT_AUTHOR
    );

    await expect(
      upsertCommentHandler({ ctx: ctx(), input: { ...baseInput, parentId: 9 } })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: COMMENTER,
      targetUserId: PARENT_AUTHOR,
    });
    expect(mockCreateOrUpdateComment).not.toHaveBeenCalled();
  });

  it('exempts moderators', async () => {
    amIBlockedByUser.mockResolvedValue(true);

    await upsertCommentHandler({ ctx: ctx({ isModerator: true }), input: baseInput });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateComment).toHaveBeenCalledTimes(1);
  });
});
