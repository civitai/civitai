import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';

const { toggleHideComment, togglePinComment } = vi.hoisted(() => ({
  toggleHideComment: vi.fn(async () => ({ id: 0 })),
  togglePinComment: vi.fn(async () => ({ id: 0 })),
}));

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  toggleHideComment,
  togglePinComment,
}));

import { togglePinnedCommentHandler, toggleHideCommentHandler } from '../commentv2.controller';

const CONTENT_OWNER = 100;
const PARENT_AUTHOR = 200;
const STRANGER = 300;
const MODERATOR = 400;

const REPLY_ID = 11;
const TOP_LEVEL_ID = 10;
const ROOT_THREAD_ID = 50;
const IMAGE_ID = 9;

const emptyThread = {
  rootThreadId: null,
  imageId: null,
  postId: null,
  articleId: null,
  modelId: null,
  reviewId: null,
  bountyId: null,
  bountyEntryId: null,
  questionId: null,
  answerId: null,
  model3dId: null,
  model3dReviewId: null,
  comicProjectId: null,
  comicChapterPosition: null,
  challengeId: null,
  appListingId: null,
};

const ctx = (id: number, isModerator = false) => ({ user: { id, isModerator } } as never);

/**
 * A reply on someone's image: comment 11 sits in the child thread of comment 10, which was written
 * by PARENT_AUTHOR on CONTENT_OWNER's image. `findFirst` is answered in the shape the previous
 * owner lookup asked for, so reverting to it resolves the parent's author and these fail on the
 * outcome rather than on an unmocked read.
 */
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.commentV2.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) =>
    where.id === REPLY_ID
      ? { hidden: false, thread: { ...emptyThread, rootThreadId: ROOT_THREAD_ID } }
      : { hidden: false, thread: { ...emptyThread, imageId: IMAGE_ID } }) as never);
  dbMock.dbRead.commentV2.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) =>
    where.id === REPLY_ID
      ? {
          hidden: false,
          pinnedAt: null,
          userId: STRANGER,
          thread: { comment: { userId: PARENT_AUTHOR } },
        }
      : {
          hidden: false,
          pinnedAt: null,
          userId: PARENT_AUTHOR,
          thread: { image: { userId: CONTENT_OWNER } },
        }) as never);
  dbMock.dbRead.thread.findUnique.mockResolvedValue({ ...emptyThread, imageId: IMAGE_ID } as never);
  dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: CONTENT_OWNER } as never);
});

const hideReply = (userId: number, isModerator = false) =>
  toggleHideCommentHandler({
    input: { id: REPLY_ID, entityType: 'comment', entityId: TOP_LEVEL_ID },
    ctx: ctx(userId, isModerator),
  });

describe('commentv2 toggleHide: who may hide a single comment', () => {
  it("lets the content owner hide a reply under someone else's comment", async () => {
    await hideReply(CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: REPLY_ID, currentToggle: false });
  });

  // Pre-existing authz bug: the owner check used to resolve a reply's "owner" as the author of the
  // comment it answers, so a top-level commenter (in the hijack case, the abuser) could hide the
  // replies pushing back on them. Do not reintroduce a lookup keyed on the client's entityType.
  it('refuses the author of the parent comment, who does not own the content', async () => {
    await expect(hideReply(PARENT_AUTHOR)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(toggleHideComment).not.toHaveBeenCalled();
  });

  it('refuses a signed-in stranger on a top-level comment', async () => {
    await expect(
      toggleHideCommentHandler({
        input: { id: TOP_LEVEL_ID, entityType: 'image', entityId: IMAGE_ID },
        ctx: ctx(STRANGER),
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(toggleHideComment).not.toHaveBeenCalled();
  });

  it('lets a moderator hide any reply', async () => {
    await hideReply(MODERATOR, true);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: REPLY_ID, currentToggle: false });
  });

  it('applies the same owner rule to pinning a reply', async () => {
    await expect(
      togglePinnedCommentHandler({
        input: { id: REPLY_ID, entityType: 'comment', entityId: TOP_LEVEL_ID },
        ctx: ctx(PARENT_AUTHOR),
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(togglePinComment).not.toHaveBeenCalled();
  });
});
