/**
 * The agent review's two LANES, and the flag that opens the connect one.
 *
 * The on-site lane reviews an `AppBlockPublishRequest` (a hosted bundle). The connect lane
 * reviews an `AppListingPublishRequest` for an OAuth-connect listing: its requested scopes, its
 * listing claims and, when the author links one, its public server source. Both run on the same
 * dispatcher, runner and report row; only the subject they load differs.
 *
 * Client-safe (no zod, Prisma or server imports): the flag key is read by the server gate and
 * registered as a client `fliptKey`, the `knightsApp` shape `.claude/rules/server.md` names.
 */

/**
 * Flipt flag for the connect lane. Mod-segmented like `app-blocks-agentic-review`, created
 * base OFF; absent or unreachable evaluates false, so the lane is dark until it exists.
 */
export const APP_LISTINGS_AGENTIC_REVIEW_FLAG = 'app-listings-agentic-review';

export type AgentReviewLane = 'onsite' | 'connect';

/** `AppListingPublishRequest` ids are `alpr_<ULID>` (`newAppListingPublishRequestId`). */
export const CONNECT_PUBLISH_REQUEST_ID_PREFIX = 'alpr_';

/**
 * Which lane a publish-request id belongs to, from its prefix. Everything that is not a listing
 * request id is the on-site lane, so every id the on-site lane accepted before keeps its lane.
 */
export function agentReviewLaneFor(publishRequestId: string): AgentReviewLane {
  return publishRequestId.startsWith(CONNECT_PUBLISH_REQUEST_ID_PREFIX) ? 'connect' : 'onsite';
}

/** The OAuth scope name an app asks for to get a refresh token (phase 1 of the token work). */
export const OFFLINE_ACCESS_SCOPE = 'offline_access';
