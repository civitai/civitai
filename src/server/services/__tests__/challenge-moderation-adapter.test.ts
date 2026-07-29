import { describe, it, expect, vi, beforeEach } from 'vitest';

// applyFailure must only downgrade a challenge that is actually mid-scan. A moderator rescan
// (rescanChallenge) is the first path that submits a workflow for an already-Scanned challenge, so
// an unscoped write would let one transient orchestrator failure hide a live challenge from the
// feeds and 404 its detail page.
const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: { challenge: { findUnique: vi.fn() } },
  mockDbWrite: { challenge: { update: vi.fn(), updateMany: vi.fn() } },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(() => Promise.resolve()) }));
vi.mock('~/server/games/daily-challenge/challenge-nsfw-escalation', () => ({
  applyChallengeNsfwEscalation: vi.fn(),
}));
vi.mock('~/server/prom/challenge.metrics', () => ({ recordChallengeScanResult: vi.fn() }));

const { challengeModerationAdapter } = await import('~/server/services/challenge-moderation.adapter');
const { applyChallengeNsfwEscalation } = await import(
  '~/server/games/daily-challenge/challenge-nsfw-escalation'
);
const { recordChallengeScanResult } = await import('~/server/prom/challenge.metrics');

describe('challengeModerationAdapter.applyFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
    // applyFailure now reads the challenge source (for the scan-result 'error' metric) after a real
    // Pending→Error transition; give findUnique a resolved value so the chained .catch() is valid.
    mockDbRead.challenge.findUnique.mockResolvedValue({ source: 'User' });
  });

  it('only marks Error on a challenge still Pending', async () => {
    await challengeModerationAdapter.applyFailure?.({
      entityId: 42,
      workflowId: 'wf-1',
      status: 'expired',
    });

    expect(mockDbWrite.challenge.updateMany).toHaveBeenCalledWith({
      where: { id: 42, ingestion: 'Pending' },
      data: { ingestion: 'Error' },
    });
    // A bare `update` here is the regression: it would downgrade a Scanned challenge too.
    expect(mockDbWrite.challenge.update).not.toHaveBeenCalled();
  });

  it('leaves an already-Scanned challenge alone when the scoped write matches nothing', async () => {
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      challengeModerationAdapter.applyFailure?.({
        entityId: 42,
        workflowId: 'wf-1',
        status: 'failed',
      })
    ).resolves.not.toThrow();
  });
});

describe('challengeModerationAdapter.applyResult telemetry-read safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The scanned (not-blocked) path fetches `source` ONLY to label the scan-result metric, guarded by
  // `.catch(() => null)`. That guard is load-bearing: a transient DB failure on this telemetry read
  // must NEVER throw out of applyResult and skip the real safety step (applyChallengeNsfwEscalation).
  // Removing the `.catch(() => null)` makes this test fail (applyResult rejects, escalation is skipped).
  it('still runs the NSFW escalation when the telemetry source read rejects', async () => {
    mockDbRead.challenge.findUnique.mockRejectedValueOnce(new Error('transient db failure'));

    await expect(
      challengeModerationAdapter.applyResult({
        entityId: 42,
        blocked: false,
        triggeredLabels: [],
        output: undefined,
      })
    ).resolves.not.toThrow();

    // Non-negotiable: the safety step still ran despite the failed telemetry read.
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledTimes(1);
    expect(applyChallengeNsfwEscalation).toHaveBeenCalledWith({ entityId: 42, isNsfw: false });

    // The failed read collapses to null → `source: undefined` is passed, which normSource maps to
    // the 'unknown' bucket — the metric is still recorded, never skipped.
    expect(recordChallengeScanResult).toHaveBeenCalledWith({ source: undefined, result: 'scanned' });
  });
});
