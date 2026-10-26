import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as AnswerController from '~/server/controllers/answer.controller';
import type * as TagController from '~/server/controllers/tag.controller';

const { setAnswerVoteHandler, addTagVotesHandler, removeTagVotesHandler } = vi.hoisted(() => ({
  setAnswerVoteHandler: vi.fn(async () => 'voted'),
  addTagVotesHandler: vi.fn(async () => 'added'),
  removeTagVotesHandler: vi.fn(async () => 'removed'),
}));

vi.mock('~/server/controllers/answer.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof AnswerController>()),
  setAnswerVoteHandler,
}));

vi.mock('~/server/controllers/tag.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof TagController>()),
  addTagVotesHandler,
  removeTagVotesHandler,
}));

import { answerRouter } from '../answer.router';
import { tagRouter } from '../tag.router';

const member = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'member',
  onboarding: 0x1f,
  emailVerified: new Date('2024-01-01'),
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
};
const restricted = { ...member, muted: true, mutedAt: new Date('2024-01-02') };

function ctxFor(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never;
}

const cases = [
  {
    name: 'answer.vote',
    handler: setAnswerVoteHandler,
    expected: 'voted',
    call: (user: unknown) => answerRouter.createCaller(ctxFor(user)).vote({ id: 5, vote: true }),
  },
  {
    name: 'tag.addTagVotes',
    handler: addTagVotesHandler,
    expected: 'added',
    call: (user: unknown) =>
      tagRouter
        .createCaller(ctxFor(user))
        .addTagVotes({ type: 'image', id: 5, tags: [7], vote: 1 }),
  },
  {
    name: 'tag.removeTagVotes',
    handler: removeTagVotesHandler,
    expected: 'removed',
    call: (user: unknown) =>
      tagRouter.createCaller(ctxFor(user)).removeTagVotes({ type: 'image', id: 5, tags: [7] }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('vote mutations use the guarded procedure', () => {
  it.each(cases)('$name reaches the handler for an ordinary member', async (c) => {
    await expect(c.call(member)).resolves.toBe(c.expected);
    expect(c.handler).toHaveBeenCalledTimes(1);
  });

  it.each(cases)('$name refuses the same accounts as reaction.toggle', async (c) => {
    await expect(c.call(restricted)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: RESTRICTED_ACCOUNT_MESSAGE,
    });
    expect(c.handler).not.toHaveBeenCalled();
  });
});
