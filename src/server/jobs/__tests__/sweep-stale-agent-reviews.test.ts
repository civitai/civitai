import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sweepStaleAgentReviews,
  STALE_AGENT_REVIEW_RUNNING_MS,
} from '~/server/jobs/sweep-stale-agent-reviews';
import { AGENT_CALLBACK_TOKEN_TTL_SECONDS } from '~/server/services/blocks/review-session';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockUpdateMany = dbMock.dbWrite.appReviewAgentReport.updateMany;

beforeEach(() => vi.clearAllMocks());

describe('sweepStaleAgentReviews', () => {
  it('flips running rows older than the cutoff → failed and returns the count', async () => {
    mockUpdateMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-07-27T12:00:00Z');

    const swept = await sweepStaleAgentReviews(now);

    expect(swept).toBe(3);
    const arg = mockUpdateMany.mock.calls[0][0];
    // Only running rows.
    expect(arg.where.status).toBe('running');
    // Cutoff = now - 90m, pinned as a literal: deriving it from the constant
    // under test would pass whatever the constant said.
    expect(arg.where.startedAt.lt.toISOString()).toBe('2026-07-27T10:30:00.000Z');
    // Flipped to failed with a completedAt + explanatory summary.
    expect(arg.data.status).toBe('failed');
    expect(arg.data.completedAt).toEqual(now);
    expect(String(arg.data.summaryMd)).toMatch(/swept/i);
  });

  it('is a no-op (returns 0) when nothing matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    expect(await sweepStaleAgentReviews(new Date())).toBe(0);
  });

  it('never sweeps a review still inside the 60m Job deadline', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const now = new Date('2026-07-27T12:00:00Z');
    await sweepStaleAgentReviews(now);
    const cutoff: Date = mockUpdateMany.mock.calls[0][0].where.startedAt.lt;
    // A review started 61 minutes ago has outlived the old 60m threshold but is
    // still within the Job deadline (60m) + callback retries: it must NOT match.
    const startedAt = new Date(now.getTime() - 61 * 60 * 1000);
    expect(startedAt < cutoff).toBe(false);
  });

  it('orders the three bounds: Job deadline (60m) < callback token TTL < sweeper', () => {
    const JOB_DEADLINE_MS = 60 * 60 * 1000; // the infra template's activeDeadlineSeconds
    expect(STALE_AGENT_REVIEW_RUNNING_MS).toBe(90 * 60 * 1000);
    expect(AGENT_CALLBACK_TOKEN_TTL_SECONDS * 1000).toBeGreaterThan(JOB_DEADLINE_MS);
    expect(STALE_AGENT_REVIEW_RUNNING_MS).toBeGreaterThan(AGENT_CALLBACK_TOKEN_TTL_SECONDS * 1000);
  });
});
