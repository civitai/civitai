import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = dbMock.dbRead.challengeJudge.findUnique;
import {
  challengeJudgingEngineForCreate,
  resolveJudgingEngineForJudge,
} from '~/server/services/challenge-judge.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

beforeEach(() => findUnique.mockReset());

describe('resolveJudgingEngineForJudge', () => {
  it('returns the judge’s engine', async () => {
    findUnique.mockResolvedValueOnce({ judgingEngine: 'pairwise-ladder' });
    await expect(resolveJudgingEngineForJudge(7)).resolves.toBe('pairwise-ladder');
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { judgingEngine: true },
    });
  });

  it('does not query at all when there is no judge', async () => {
    await expect(resolveJudgingEngineForJudge(null)).resolves.toBe('legacy-absolute');
    await expect(resolveJudgingEngineForJudge(undefined)).resolves.toBe('legacy-absolute');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('falls back to legacy for a value the registry does not know', async () => {
    findUnique.mockResolvedValueOnce({ judgingEngine: 'swiss-tournament' });
    await expect(resolveJudgingEngineForJudge(7)).resolves.toBe('legacy-absolute');
  });

  it('falls back to legacy when the column does not exist yet', async () => {
    findUnique.mockRejectedValueOnce(
      Object.assign(new Error('column does not exist'), { code: 'P2022' })
    );
    await expect(resolveJudgingEngineForJudge(7)).resolves.toBe('legacy-absolute');
  });
});

describe('challengeJudgingEngineForCreate', () => {
  it('omits the column for the default engine, so an unmigrated database still creates', async () => {
    findUnique.mockResolvedValueOnce({ judgingEngine: 'legacy-absolute' });
    await expect(challengeJudgingEngineForCreate(7)).resolves.toEqual({});
  });

  it('writes the column for a non-default engine', async () => {
    findUnique.mockResolvedValueOnce({ judgingEngine: 'pairwise-ladder' });
    await expect(challengeJudgingEngineForCreate(7)).resolves.toEqual({
      judgingEngine: 'pairwise-ladder',
    });
  });
});
