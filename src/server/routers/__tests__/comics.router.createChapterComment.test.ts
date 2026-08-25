import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

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

const { throwOnBlockedCommentContent } = vi.hoisted(() => ({
  throwOnBlockedCommentContent: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));

vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedCommentContent }));

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

function fakeCtx({ isModerator = false }: { isModerator?: boolean } = {}) {
  return {
    // `comicGuardedProcedure` runs isOnboarded then isMuted, so a bare `{ id }` is refused
    // before the handler with an onboarding error the assertions below would misread.
    user: { id: USER_ID, isModerator, onboarding: OnboardingSteps.Buzz, muted: false },
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

const input = { projectId: 1, chapterPosition: 0, content: '<p>nice chapter</p>' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  throwOnBlockedCommentContent.mockResolvedValue(undefined);
  dbMock.dbWrite.thread.upsert.mockResolvedValue({ id: 1, locked: false });
  dbMock.dbWrite.commentV2.create.mockResolvedValue({
    id: 99,
    content: 'x',
    createdAt: new Date(),
  });
  dbMock.dbWrite.thread.update.mockResolvedValue({ id: 1 });
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue({ userId: USER_ID, name: 'p' });
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
