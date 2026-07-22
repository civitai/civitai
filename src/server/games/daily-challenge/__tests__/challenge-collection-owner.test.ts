import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockGetChallengeConfig } = vi.hoisted(() => ({
  mockDbRead: { challengeJudge: { findUnique: vi.fn() } },
  mockGetChallengeConfig: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
}));

const { resolveChallengeCollectionOwnerId } = await import(
  '~/server/games/daily-challenge/challenge-collection-owner'
);

describe('resolveChallengeCollectionOwnerId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue({ defaultJudgeId: 7 });
  });

  it('returns the user account of the judge passed in', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue({ userId: 555 });

    await expect(resolveChallengeCollectionOwnerId(3)).resolves.toBe(555);
    expect(mockDbRead.challengeJudge.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { userId: true },
    });
  });

  it('falls back to the configured default judge when none is passed', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue({ userId: 999 });

    await expect(resolveChallengeCollectionOwnerId(null)).resolves.toBe(999);
    expect(mockDbRead.challengeJudge.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { userId: true },
    });
  });

  it('throws when neither a judge nor a default judge is configured', async () => {
    mockGetChallengeConfig.mockResolvedValue({ defaultJudgeId: undefined });

    await expect(resolveChallengeCollectionOwnerId(undefined)).rejects.toThrow(
      'No challenge judge is configured.'
    );
    expect(mockDbRead.challengeJudge.findUnique).not.toHaveBeenCalled();
  });

  it('throws naming the id when the resolved judge has no ChallengeJudge row', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue(null);

    await expect(resolveChallengeCollectionOwnerId(42)).rejects.toThrow(
      'No challenge judge found for id 42.'
    );
  });
});
