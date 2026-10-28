import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as CommentV2Controller from '~/server/controllers/commentv2.controller';

const OWNER = 7;

const handlers = vi.hoisted(() => ({ deleteCommentV2Handler: vi.fn(async () => ({ id: 1 })) }));
vi.mock('~/server/controllers/commentv2.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentV2Controller>()),
  ...handlers,
}));

import { commentv2Router } from '../commentv2.router';

const caller = () =>
  commentv2Router.createCaller({
    acceptableOrigin: true,
    user: { id: OWNER, isModerator: false, tier: 'free', username: 'o', onboarding: 0x1f },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);

const deleteAs = async (row: { userId: number; tosViolation: boolean } | null) => {
  vi.mocked(dbMock.dbRead.commentV2.findUnique).mockResolvedValue(row as never);
  return caller()
    .delete({ id: 1 })
    .then(
      () => 'allowed',
      (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
    );
};

beforeEach(() => vi.clearAllMocks());

// An author's own delete keeps a comment for a hold by hiding it for ToS: to them it must answer
// exactly as a comment that is gone.
describe("the comment owner gate on an author's own comment", () => {
  it('refuses one hidden for ToS exactly as one that is gone', async () => {
    const gone = await deleteAs(null);
    expect(gone).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await deleteAs({ userId: OWNER, tosViolation: true })).toEqual(gone);
    expect(handlers.deleteCommentV2Handler).not.toHaveBeenCalled();
  });

  it('lets the author act on a live one (control)', async () => {
    expect(await deleteAs({ userId: OWNER, tosViolation: false })).toBe('allowed');
  });
});
