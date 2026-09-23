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

const IMAGE_ID = 9;
const ATTACKER_IMAGE_ID = 8;

const TOP_LEVEL_ID = 10;
const REPLY_ID = 11;
const HIDDEN_ID = 12;
const ORPHAN_ID = 13;
const FORGED_REPLY_ID = 15;
const UNPOINTED_REPLY_ID = 16;

const emptyThread = {
  commentId: null as number | null,
  rootThreadId: null as number | null,
  imageId: null as number | null,
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

/**
 * CONTENT_OWNER's image (thread 50) carries top-level comment 10 by PARENT_AUTHOR, and the replies
 * to it live in child threads of that comment. Thread 53's `rootThreadId` is forged: the first
 * replier named PARENT_AUTHOR's own image thread (60) as the parent, which is a column written from
 * client input. Thread 54 has no root pointer at all. Thread 70 is an orphan whose parent comment is
 * gone.
 */
const threads: Record<number, typeof emptyThread> = {
  50: { ...emptyThread, imageId: IMAGE_ID },
  52: { ...emptyThread, commentId: TOP_LEVEL_ID, rootThreadId: 50 },
  53: { ...emptyThread, commentId: TOP_LEVEL_ID, rootThreadId: 60 },
  54: { ...emptyThread, commentId: TOP_LEVEL_ID },
  60: { ...emptyThread, imageId: ATTACKER_IMAGE_ID },
  70: { ...emptyThread },
};
const comments: Record<number, { hidden: boolean; threadId: number }> = {
  [TOP_LEVEL_ID]: { hidden: false, threadId: 50 },
  [REPLY_ID]: { hidden: false, threadId: 52 },
  [HIDDEN_ID]: { hidden: true, threadId: 50 },
  [ORPHAN_ID]: { hidden: false, threadId: 70 },
  [FORGED_REPLY_ID]: { hidden: false, threadId: 53 },
  [UNPOINTED_REPLY_ID]: { hidden: false, threadId: 54 },
};
const imageOwners: Record<number, number> = {
  [IMAGE_ID]: CONTENT_OWNER,
  [ATTACKER_IMAGE_ID]: PARENT_AUTHOR,
};

/** Walks `Thread.commentId -> CommentV2.threadId` from the seed the CTE was built with. */
function walkToTop(sql: string) {
  let id = Number(/SELECT (\d+) "id"/.exec(sql)?.[1]);
  for (let depth = 0; depth < 100; depth++) {
    const parent = threads[id]?.commentId;
    if (parent == null || !comments[parent]) break;
    id = comments[parent].threadId;
  }
  return [{ id }];
}

const ctx = (id: number, isModerator = false) => ({ user: { id, isModerator } } as never);

// Answers the stored-chain walk and, for a revert control, the previous `rootThreadId` read too.
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.commentV2.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const c = comments[where.id];
    return c ? { ...c, thread: threads[c.threadId] } : null;
  }) as never);
  dbMock.dbRead.$queryRaw.mockImplementation((async (...args: unknown[]) =>
    walkToTop(
      args
        .slice(1)
        .map((v) => ((v as { strings?: string[] })?.strings ?? []).join(''))
        .join('')
    )) as never);
  dbMock.dbRead.thread.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) => threads[where.id] ?? null) as never
  );
  dbMock.dbRead.image.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
    imageOwners[where.id] ? { userId: imageOwners[where.id] } : null) as never);
});

const toggle = (id: number, userId: number) =>
  toggleHideCommentHandler({
    input: { id, entityType: 'image', entityId: IMAGE_ID },
    ctx: ctx(userId),
  });
const pin = (id: number, userId: number) =>
  togglePinnedCommentHandler({
    input: { id, entityType: 'image', entityId: IMAGE_ID },
    ctx: ctx(userId),
  });

const hideReply = (userId: number, isModerator = false) =>
  toggleHideCommentHandler({
    input: { id: REPLY_ID, entityType: 'comment', entityId: TOP_LEVEL_ID },
    ctx: ctx(userId, isModerator),
  });

describe('commentv2 toggleHide: who may hide a single comment', () => {
  it("lets the content owner hide a reply under someone else's comment", async () => {
    await hideReply(CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledTimes(1);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: REPLY_ID, currentToggle: false });
  });

  it('lets the content owner hide a top-level comment', async () => {
    await toggle(TOP_LEVEL_ID, CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledTimes(1);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: TOP_LEVEL_ID, currentToggle: false });
  });

  it('passes the stored hidden state through, so an owner can unhide', async () => {
    await toggle(HIDDEN_ID, CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: HIDDEN_ID, currentToggle: true });
  });

  // No resolvable owner must mean "moderators only", never "anyone".
  it.each([
    ['a stranger', STRANGER],
    ['the author of the orphaned parent', PARENT_AUTHOR],
  ])('refuses %s on an orphaned thread, which resolves no owner', async (_label, id) => {
    await expect(toggle(ORPHAN_ID, id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(pin(ORPHAN_ID, id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(toggleHideComment).not.toHaveBeenCalled();
    expect(togglePinComment).not.toHaveBeenCalled();
  });

  // Pre-existing authz bug: the owner check used to resolve a reply's "owner" as the author of the
  // comment it answers, so a top-level commenter (in the hijack case, the abuser) could hide the
  // replies pushing back on them. Do not reintroduce a lookup keyed on the client's entityType.
  it('refuses the author of the parent comment, who does not own the content', async () => {
    await expect(hideReply(PARENT_AUTHOR)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(toggleHideComment).not.toHaveBeenCalled();
  });

  // `Thread.rootThreadId` is written from the first replier's `parentThreadId`, so reading it lets
  // that replier point the thread at content they own. The owner comes from the stored chain.
  it('ignores a forged root pointer: the real owner may hide, the forger may not', async () => {
    await expect(toggle(FORGED_REPLY_ID, PARENT_AUTHOR)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(toggleHideComment).not.toHaveBeenCalled();
    await toggle(FORGED_REPLY_ID, CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledWith({ id: FORGED_REPLY_ID, currentToggle: false });
  });

  it('resolves the owner of a reply thread that has no root pointer', async () => {
    await toggle(UNPOINTED_REPLY_ID, CONTENT_OWNER);
    expect(toggleHideComment).toHaveBeenCalledWith({
      id: UNPOINTED_REPLY_ID,
      currentToggle: false,
    });
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

  it('lets the content owner pin a reply', async () => {
    await togglePinnedCommentHandler({
      input: { id: REPLY_ID, entityType: 'comment', entityId: TOP_LEVEL_ID },
      ctx: ctx(CONTENT_OWNER),
    });
    expect(togglePinComment).toHaveBeenCalledTimes(1);
    expect(togglePinComment).toHaveBeenCalledWith({ id: REPLY_ID });
  });
});
