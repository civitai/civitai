import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
dbMock.dbWrite.challenge.create.mockResolvedValue({ id: 99 });

// The system/cron creation path. Same contract as the two service paths: the engine comes off the
// judge row and is COPIED, and the column is omitted when it resolves to the default.
vi.mock('~/server/prom/challenge.metrics', () => ({
  recordChallengeOperationSpentBuzz: vi.fn(),
  recordChallengeWinnerConflictUnresolved: vi.fn(),
  recordChallengeWinnerPlaceDivergence: vi.fn(),
}));

const { createChallengeRecord } = await import('~/server/games/daily-challenge/challenge-helpers');

const input = {
  startsAt: new Date('2026-08-01T00:00:00Z'),
  endsAt: new Date('2026-08-02T00:00:00Z'),
  visibleAt: new Date('2026-08-01T00:00:00Z'),
  title: 'Daily challenge',
  prizes: [],
  createdById: 1,
  judgeId: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.challenge.create.mockResolvedValue({ id: 99 });
});

describe('createChallengeRecord — judging engine', () => {
  it('writes the judge’s engine onto the new challenge', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue({ judgingEngine: 'pairwise-ladder' });

    await createChallengeRecord(input as never);

    expect(mockDbRead.challengeJudge.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { judgingEngine: true },
    });
    expect(mockDbWrite.challenge.create.mock.calls[0][0].data.judgingEngine).toBe(
      'pairwise-ladder'
    );
  });

  it('omits the column entirely for a legacy judge', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue({ judgingEngine: 'legacy-absolute' });

    await createChallengeRecord(input as never);

    expect(mockDbWrite.challenge.create.mock.calls[0][0].data).not.toHaveProperty('judgingEngine');
  });

  it('omits the column when the challenge has no judge, without querying for one', async () => {
    await createChallengeRecord({ ...input, judgeId: null } as never);

    expect(mockDbRead.challengeJudge.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.challenge.create.mock.calls[0][0].data).not.toHaveProperty('judgingEngine');
  });
});
