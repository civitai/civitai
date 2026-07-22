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

const { challengeModerationAdapter } = await import('~/server/services/challenge-moderation.adapter');

describe('challengeModerationAdapter.applyFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
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
