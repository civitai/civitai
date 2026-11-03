import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as BlockCheckService from '~/server/services/block-check.service';
import type * as NotificationService from '~/server/services/notification.service';

/**
 * `createChapterComment` is the third comment write path, and until 868kw2f8y it had no
 * blocklist check of any kind — not even the link-domain one the other two carried. It is also
 * the only one with no neighbouring suite to lean on: deleting the guard call was invisible to
 * every test in the workspace.
 *
 * These assert the CALL and its ORDERING, which is all a mocked guard can pin. The ordering half
 * is the point: a guard running after the writes would leave the phishing comment in the table
 * and merely fail the request.
 */

const { throwOnBlockedCommentContent, createNotification, throwIfBlockedByOwners } = vi.hoisted(
  () => ({
    throwOnBlockedCommentContent: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    createNotification: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    throwIfBlockedByOwners: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  })
);

vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedCommentContent }));
vi.mock('~/server/services/block-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCheckService>()),
  throwIfBlockedByOwners,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

// `isFlagProtected` recomputes flags from the user via `getFeatureFlags` and ignores `ctx.features`,
// so a non-moderator caller is FORBIDDEN before reaching the handler. Spread the real module rather
// than listing exports, so this does not couple the suite to the router's whole import graph.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;

function fakeCtx({ isModerator = false, muted = false } = {}) {
  return {
    // `comicGuardedProcedure` runs isOnboarded then isMuted, so a bare `{ id }` is refused
    // before the handler with an onboarding error the assertions below would misread.
    user: { id: USER_ID, isModerator, onboarding: OnboardingSteps.Buzz, muted },
    // `isAcceptableOrigin` rejects with "Please use the public API instead" without this, which
    // would make the rejection assertions below pass on the wrong error.
    acceptableOrigin: true,
    needsUpdate: false,
    // Session auth, not an API key: `requiredScope` is checked against this.
    tokenScope: TokenScope.Full,
    // `comicCreator` opens `isFlagProtected`; `ruOrchestratorProxy` absent makes the region
    // proxy middleware early-return without touching the response.
    features: { comicCreator: true } as never,
    req: undefined,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    track: { comment: vi.fn(), commentEvent: vi.fn() } as never,
    ip: '127.0.0.1',
    fingerprint: 'test' as never,
  };
}

const input = { chapterId: 3, content: '<p>nice chapter</p>' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  throwOnBlockedCommentContent.mockResolvedValue(undefined);
  dbMock.dbWrite.thread.upsert.mockResolvedValue({ id: 1, locked: false });
  dbMock.dbWrite.commentV2.create.mockResolvedValue({
    id: 99,
    content: 'x',
    createdAt: new Date(),
  });
  dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
    projectId: 1,
    position: 0,
    name: 'c',
    project: { userId: USER_ID, name: 'p' },
  });
});

describe('comics.createChapterComment - blocklist guard wiring', () => {
  it('runs the guard once on the submitted content, with the caller moderator flag', async () => {
    const caller = comicsRouter.createCaller(fakeCtx() as never);
    await caller.createChapterComment(input);

    expect(throwOnBlockedCommentContent).toHaveBeenCalledTimes(1);
    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('<p>nice chapter</p>', {
      isModerator: false,
    });
  });

  // The comment_count_update trigger on CommentV2 already bumps Thread.commentCount; a second
  // increment here left every comic chapter thread over-counted.
  it('does not bump Thread.commentCount by hand', async () => {
    const caller = comicsRouter.createCaller(fakeCtx() as never);
    await caller.createChapterComment(input);

    expect(dbMock.dbWrite.thread.update).not.toHaveBeenCalled();
  });

  it('forwards a moderator through to the guard rather than deciding locally', async () => {
    const caller = comicsRouter.createCaller(fakeCtx({ isModerator: true }) as never);
    await caller.createChapterComment(input);

    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('<p>nice chapter</p>', {
      isModerator: true,
    });
  });

  it('rejects before writing the comment OR the thread when the guard throws', async () => {
    throwOnBlockedCommentContent.mockRejectedValueOnce(new Error('blocked'));
    const caller = comicsRouter.createCaller(fakeCtx() as never);

    // Named, not bare: a bare `.rejects.toThrow()` passes on any middleware rejection, which is
    // exactly how this test passed while the two above were failing on an auth error.
    await expect(caller.createChapterComment(input)).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.commentV2.create).not.toHaveBeenCalled();
    // The thread upsert too: a rejected comment must not leave a Thread row behind, which is
    // why the guard sits above it rather than beside the create.
    expect(dbMock.dbWrite.thread.upsert).not.toHaveBeenCalled();
  });
});

describe('comics.createChapterComment - the chapter it writes to', () => {
  const OWNER_ID = 42;
  const chapterAt = (position: number, ownerId = OWNER_ID) =>
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue({
      projectId: 1,
      position,
      name: 'Chapter three',
      project: { userId: ownerId, name: 'p' },
    });

  it("writes to the thread at the chapter's project and position", async () => {
    chapterAt(2);
    await comicsRouter.createCaller(fakeCtx() as never).createChapterComment(input);

    expect(dbMock.dbRead.comicChapter.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3 } })
    );
    expect(dbMock.dbWrite.thread.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          comicProjectId_comicChapterPosition: { comicProjectId: 1, comicChapterPosition: 2 },
        },
        create: { comicProjectId: 1, comicChapterPosition: 2 },
      })
    );
  });

  it('refuses a chapter that does not exist, writing nothing', async () => {
    dbMock.dbRead.comicChapter.findUnique.mockResolvedValue(null);
    await expect(
      comicsRouter.createCaller(fakeCtx() as never).createChapterComment(input)
    ).rejects.toThrow('Chapter not found');
    expect(dbMock.dbWrite.thread.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.commentV2.create).not.toHaveBeenCalled();
  });

  it('notifies the project owner, with the position the link is built from', async () => {
    chapterAt(2);
    await comicsRouter.createCaller(fakeCtx() as never).createChapterComment(input);

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'new-comic-comment',
        userId: OWNER_ID,
        dedupeKey: 'comment:v2:99',
        details: expect.objectContaining({ chapterPosition: 2, commentId: 99 }),
      })
    );
  });

  it('does not notify the owner of their own comment', async () => {
    chapterAt(2, USER_ID);
    await comicsRouter.createCaller(fakeCtx() as never).createChapterComment(input);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("refuses a commenter the comic's owner has blocked, writing nothing", async () => {
    chapterAt(2);
    throwIfBlockedByOwners.mockRejectedValueOnce(new Error('blocked by owner'));
    await expect(
      comicsRouter.createCaller(fakeCtx() as never).createChapterComment(input)
    ).rejects.toThrow('blocked by owner');
    expect(throwIfBlockedByOwners).toHaveBeenCalledWith({
      userId: USER_ID,
      ownerIds: [OWNER_ID],
      isModerator: false,
    });
    expect(dbMock.dbWrite.thread.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.commentV2.create).not.toHaveBeenCalled();
  });

  it('refuses a muted account before reading anything', async () => {
    await expect(
      comicsRouter.createCaller(fakeCtx({ muted: true }) as never).createChapterComment(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbRead.comicChapter.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.commentV2.create).not.toHaveBeenCalled();
  });
});
