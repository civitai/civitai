import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTIC MOD CODE-REVIEW — stale-`running`-report-row sweeper (core fn).
 *
 * Covers sweepStaleAgentReviews against a mocked dbWrite:
 *   - flips only status='running' rows older than the 60m cutoff → 'failed'
 *   - returns the swept count
 *   - dark/no-op: zero matches → 0
 */

const { mockUpdateMany } = vi.hoisted(() => ({ mockUpdateMany: vi.fn() }));

vi.mock('~/server/db/client', () => ({
  dbWrite: { appReviewAgentReport: { updateMany: mockUpdateMany } },
}));
// The job module also imports the logging client + prom-backed createJob; stub
// the logger so importing the module is side-effect-free in the test env.
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import {
  sweepStaleAgentReviews,
  STALE_AGENT_REVIEW_RUNNING_MS,
} from '~/server/jobs/sweep-stale-agent-reviews';

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
    // Cutoff = now - 60m.
    const expectedCutoff = new Date(now.getTime() - STALE_AGENT_REVIEW_RUNNING_MS);
    expect(arg.where.startedAt.lt.getTime()).toBe(expectedCutoff.getTime());
    // Flipped to failed with a completedAt + explanatory summary.
    expect(arg.data.status).toBe('failed');
    expect(arg.data.completedAt).toEqual(now);
    expect(String(arg.data.summaryMd)).toMatch(/swept/i);
  });

  it('is a no-op (returns 0) when nothing matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    expect(await sweepStaleAgentReviews(new Date())).toBe(0);
  });

  it('sanity: the threshold exceeds the Job activeDeadlineSeconds (30m)', () => {
    expect(STALE_AGENT_REVIEW_RUNNING_MS).toBeGreaterThan(30 * 60 * 1000);
  });
});
