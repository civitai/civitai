import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import type * as CommentsV2 from '~/server/services/commentsv2.service';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as ChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';

// The judge's review text is written by an LLM from a member's image, so it goes through the same
// content and block checks as any author's comment. Re-review only needs to reach its own comment
// when that comment is hidden for ToS, which is a narrower thing than acting as a moderator.

const { upsertComment } = vi.hoisted(() => ({ upsertComment: vi.fn(async () => ({ id: 1 })) }));

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2>()),
  upsertComment,
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  getChallengeById: vi.fn(async () => ({
    id: 3,
    status: 'Active',
    judgeId: 4,
    collectionId: 5,
    theme: 'cats',
    judgingPrompt: null,
    metadata: {},
  })),
  resolveChallengeReviewInputs: vi.fn(async () => ({ categories: [], nsfw: false })),
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({ judgedTagId: 6 })),
  getJudgingConfig: vi.fn(async () => ({ userId: 77 })),
}));
vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  generateReview: vi.fn(async () => ({ score: {}, summary: 's', comment: 'Lovely cat.' })),
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<void>>) => {
    for (const t of tasks) await t();
  },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const handler = (await import('~/pages/api/mod/daily-challenge/re-review')).default as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<unknown>;

const run = async () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await handler({ query: { challengeId: '3' }, body: {} } as unknown as NextApiRequest, res);
  return res;
};

const entry = { imageId: 10, userId: 2, username: 'u', url: 'x', hasJudgedTag: true };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('re-review: the judge comment', () => {
  it('edits a hidden judge comment without the moderator exemptions', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ ...entry, judgeCommentId: 90 }]);
    await run();

    expect(upsertComment).toHaveBeenCalledTimes(1);
    const [args] = upsertComment.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args).toMatchObject({ id: 90, includeHidden: true, userId: 77, content: 'Lovely cat.' });
    expect(args.isModerator).toBeFalsy();
  });

  it('creates a missing judge comment as a plain author', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ ...entry, judgeCommentId: null }]);
    await run();

    const [args] = upsertComment.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args).not.toHaveProperty('id');
    expect(args.includeHidden).toBeFalsy();
    expect(args.isModerator).toBeFalsy();
  });
});
