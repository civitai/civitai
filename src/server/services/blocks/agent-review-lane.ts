import type { SessionUser } from '~/types/session';
import { agentReviewLaneFor } from '~/shared/constants/connect-agent-review.constants';

/**
 * Whether `user` may use the agent review for this publish request: the on-site lane's flag for
 * an on-site request, the connect lane's own flag for an OAuth-connect listing request.
 *
 * 🔴 ONE GATE FOR EVERY AGENT-REVIEW PROCEDURE (start, read, chat). The lane is decided by the
 * request id, so a connect request can never be started, read or chatted about on the on-site
 * flag alone, and an on-site request is gated exactly as it was before the connect lane existed.
 */
export async function isAgentReviewLaneEnabled(
  publishRequestId: string,
  opts: { user?: SessionUser }
): Promise<boolean> {
  const flags = await import('~/server/services/app-blocks-flag');
  return agentReviewLaneFor(publishRequestId) === 'connect'
    ? flags.isAppListingsAgenticReviewEnabled(opts)
    : flags.isAppBlocksAgenticReviewEnabled(opts);
}
