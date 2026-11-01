import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleService from '~/server/services/crucible.service';
import type { ProtectedContext } from '~/server/createContext';
import { dbMock } from '~/__tests__/mocks';
import {
  CRUCIBLE_JUDGE_MIN_CREATOR_SCORE,
  CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE,
} from '~/shared/constants/crucible.constants';

const submitVote = vi.fn();
const getJudgingPair = vi.fn();

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  submitVote,
  getJudgingPair,
}));

const { getJudgeEligibilityHandler, getJudgingPairHandler, submitVoteHandler } = await import(
  '~/server/controllers/crucible.controller'
);

const ctxFor = (isModerator = false) =>
  ({ user: { id: 7, isModerator }, features: {} } as unknown as ProtectedContext);

const withScore = (total: number | undefined) =>
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: total === undefined ? {} : { scores: { total } },
  });

const voteInput = {
  crucibleId: 1,
  winnerEntryId: 2,
  loserEntryId: 3,
  judgingSessionId: 'session',
} as Parameters<typeof submitVoteHandler>[0]['input'];
const pairInput = { crucibleId: 1, browsingLevel: 1 } as Parameters<
  typeof getJudgingPairHandler
>[0]['input'];

beforeEach(() => {
  vi.clearAllMocks();
  submitVote.mockResolvedValue({ winnerElo: 1, loserElo: 1, winnerEntryId: 2, loserEntryId: 3 });
  getJudgingPair.mockResolvedValue(null);
});

describe('crucible judging requires a creator score', () => {
  it('is 500, about the median for a week-old account that both posts and comments', () => {
    expect(CRUCIBLE_JUDGE_MIN_CREATOR_SCORE).toBe(500);
  });

  it.each([
    ['one below the threshold', CRUCIBLE_JUDGE_MIN_CREATOR_SCORE - 1],
    ['zero', 0],
    ['negative, from TOS deletions', -1880],
    ['absent, before the nightly score job first runs', undefined],
  ])('refuses a vote when the score is %s, without reaching the vote', async (_, total) => {
    withScore(total);

    await expect(submitVoteHandler({ input: voteInput, ctx: ctxFor() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE,
    });
    expect(submitVote).not.toHaveBeenCalled();
  });

  it('refuses to serve a pair below the threshold', async () => {
    withScore(CRUCIBLE_JUDGE_MIN_CREATOR_SCORE - 1);

    await expect(getJudgingPairHandler({ input: pairInput, ctx: ctxFor() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE,
    });
    expect(getJudgingPair).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly at the threshold', CRUCIBLE_JUDGE_MIN_CREATOR_SCORE],
    ['above it', 94_837],
  ])('accepts a vote and serves a pair when the score is %s', async (_, total) => {
    withScore(total);

    await submitVoteHandler({ input: voteInput, ctx: ctxFor() });
    await getJudgingPairHandler({ input: pairInput, ctx: ctxFor() });

    expect(submitVote).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
    expect(getJudgingPair).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });

  it('lets a moderator judge whatever their score, as crucible creation does', async () => {
    withScore(0);

    await submitVoteHandler({ input: voteInput, ctx: ctxFor(true) });

    expect(submitVote).toHaveBeenCalledTimes(1);
  });

  it('tells the judge page a moderator can judge, so it does not show them the refusal', async () => {
    withScore(0);

    await expect(getJudgeEligibilityHandler({ ctx: ctxFor(true) })).resolves.toMatchObject({
      canJudge: true,
    });
  });

  it('reports the score so the judge page can explain a refusal', async () => {
    withScore(120);

    await expect(getJudgeEligibilityHandler({ ctx: ctxFor() })).resolves.toEqual({
      canJudge: false,
      score: 120,
    });
    expect(dbMock.dbRead.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
  });
});
