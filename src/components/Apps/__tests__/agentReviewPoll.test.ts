import { describe, expect, it } from 'vitest';
import {
  AGENT_REVIEW_POLL_MS,
  MAX_CONSECUTIVE_POLL_ERRORS,
  MAX_POLL_MS,
  computeAgentReviewPollInterval,
} from '~/components/Apps/AgentReviewPanel';

/**
 * PURE poll-interval decision for the agentic-review panel (P2). The panel polls
 * `getAgentReview` every 4s while a run is `running`, but must NOT refetch forever
 * if the poll starts erroring mid-run or a backend run wedges in `running`. This
 * helper bounds the poll on BOTH an error ceiling and a time ceiling.
 */

describe('computeAgentReviewPollInterval', () => {
  it('running + no failures + within the time cap → polls at 4000ms', () => {
    expect(
      computeAgentReviewPollInterval({ status: 'running', consecutiveFailures: 0, elapsedMs: 0 })
    ).toBe(AGENT_REVIEW_POLL_MS);
    expect(AGENT_REVIEW_POLL_MS).toBe(4000);
  });

  it('a SINGLE transient failure (1 < threshold) does NOT stop the poll', () => {
    expect(
      computeAgentReviewPollInterval({ status: 'running', consecutiveFailures: 1, elapsedMs: 0 })
    ).toBe(AGENT_REVIEW_POLL_MS);
    // Right up to (but below) the threshold it still polls.
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: MAX_CONSECUTIVE_POLL_ERRORS - 1,
        elapsedMs: 0,
      })
    ).toBe(AGENT_REVIEW_POLL_MS);
  });

  it('a PERSISTENT error (>= MAX_CONSECUTIVE_POLL_ERRORS) stops the poll → false', () => {
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: MAX_CONSECUTIVE_POLL_ERRORS,
        elapsedMs: 0,
      })
    ).toBe(false);
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: MAX_CONSECUTIVE_POLL_ERRORS + 5,
        elapsedMs: 0,
      })
    ).toBe(false);
  });

  it('an over-long run (elapsedMs >= MAX_POLL_MS) stops the poll → false', () => {
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: 0,
        elapsedMs: MAX_POLL_MS,
      })
    ).toBe(false);
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: 0,
        elapsedMs: MAX_POLL_MS + 1,
      })
    ).toBe(false);
    // Just under the cap still polls.
    expect(
      computeAgentReviewPollInterval({
        status: 'running',
        consecutiveFailures: 0,
        elapsedMs: MAX_POLL_MS - 1,
      })
    ).toBe(AGENT_REVIEW_POLL_MS);
  });

  it('any non-running status stops the poll → false', () => {
    for (const status of ['complete', 'cost-capped', 'failed', 'torn-down', undefined]) {
      expect(
        computeAgentReviewPollInterval({ status, consecutiveFailures: 0, elapsedMs: 0 })
      ).toBe(false);
    }
  });
});
