import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';

// Hand-listed, as in challenge-moderation-adapter.test.ts.
vi.mock('~/server/games/daily-challenge/challenge-nsfw-escalation', () => ({
  applyChallengeNsfwEscalation: vi.fn(),
}));
vi.mock('~/server/prom/challenge.metrics', () => ({ recordChallengeScanResult: vi.fn() }));

const { applyChallengeTextScan, settleSkippedChallengeScan } = await import(
  '~/server/services/text-scan/actions/challenge'
);
const { applyChallengeNsfwEscalation } = await import(
  '~/server/games/daily-challenge/challenge-nsfw-escalation'
);
const { recordChallengeScanResult } = await import('~/server/prom/challenge.metrics');

const args = (detectedLevel: number, raised = false) => ({
  entityId: 3,
  workflowId: 'wf',
  outcome: {
    nsfw: { detectedLevel, declaredLevel: 4, raised, reason: 'r' },
    triggeredLabels: [],
    nsfwLevel: detectedLevel,
  },
  subject: { fields: [], declared: { nsfwLevel: 4 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  dbMock.dbWrite.challenge.findUnique.mockResolvedValue({ source: 'User' });
});

describe('applyChallengeTextScan', () => {
  it.each([
    [NsfwLevel.PG, false],
    [NsfwLevel.PG13, false],
    [NsfwLevel.R, true],
    [NsfwLevel.XXX, true],
  ])('detected %s escalates as isNsfw=%s', async (level, isNsfw) => {
    await applyChallengeTextScan(args(level) as never);
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 3, isNsfw });
    expect(recordChallengeScanResult).toHaveBeenCalledWith({ source: 'User', result: 'scanned' });
  });

  it('stays NSFW on a rescan after its own escalation raised the declared level', async () => {
    await applyChallengeTextScan(args(NsfwLevel.R, false) as never);
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 3, isNsfw: true });
  });

  it('ignores a deleted challenge and a verdict without nsfw', async () => {
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue(null);
    await applyChallengeTextScan(args(NsfwLevel.X) as never);
    await applyChallengeTextScan({ ...args(NsfwLevel.X), outcome: { triggeredLabels: [], nsfwLevel: null } } as never);
    expect(applyChallengeNsfwEscalation).not.toHaveBeenCalled();
  });
});

describe('settleSkippedChallengeScan', () => {
  it('re-applies the stored verdict when the scan skipped unchanged text', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: NsfwLevel.X,
      result: { version: 1 },
    });
    await settleSkippedChallengeScan(3, 'unchanged');
    expect(dbMock.dbWrite.entityModeration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId: { entityType: 'Challenge', entityId: 3 } },
      })
    );
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 3, isNsfw: true });
  });

  it('does not count a re-applied verdict as a new scan', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: NsfwLevel.PG,
      result: { version: 1 },
    });
    await settleSkippedChallengeScan(3, 'unchanged');
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 3, isNsfw: false });
    expect(recordChallengeScanResult).not.toHaveBeenCalled();
  });

  it('waits for the callback of a scan already in flight', async () => {
    await settleSkippedChallengeScan(3, 'in-flight');
    expect(applyChallengeNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('settles text too short to scan as clean', async () => {
    await settleSkippedChallengeScan(3, 'too-short');
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 3, isNsfw: false });
  });

  it('does nothing for a deleted challenge', async () => {
    await settleSkippedChallengeScan(3, 'missing');
    expect(applyChallengeNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it.each(['missing-prompt', 'no-profile'] as const)('leaves %s Pending and logs it', async (reason) => {
    await settleSkippedChallengeScan(3, reason);
    expect(applyChallengeNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', challengeId: 3, reason })
    );
  });

  it('logs rather than guessing when an unchanged row holds no text-scan verdict', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: null,
      result: { blocked: false },
    });
    await settleSkippedChallengeScan(3, 'unchanged');
    expect(applyChallengeNsfwEscalation).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalled();
  });
});
