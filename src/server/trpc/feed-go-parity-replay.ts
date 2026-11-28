/**
 * feed-go's serve-side parity replay (apps/feed-go/DESIGN.md §7.2, `ParityReplayHeader`): once a
 * procedure is served by feed-go, feed-go re-asks this app for a small sampled fraction of the
 * requests it served, after it has answered, and compares the two answers. The replay carries this
 * header, and this app then:
 *
 * - never shadow-samples it (`createFeedGoShadow`'s `begin`, and `beginRest` for the REST routes:
 *   feed-go replays `/api/v1/models` and `/api/v1/models/[id]` too): the sample would be posted back
 *   to feed-go as a comparison of a request it has already compared;
 * - writes it as superjson, never devalue (`runWithResponseWriteFormat`): the comparison reads the
 *   superjson envelope, the format the shadow sampler sends.
 *
 * A client that sends the header itself only opts out of both, which changes nothing it reads
 * (superjson is the format every client decodes).
 */
export const FEED_GO_PARITY_REPLAY_HEADER = 'x-feed-go-parity-replay';

/** Whether the request is a feed-go parity replay (the header is present, whatever its value). */
export function isFeedGoParityReplay(
  headers: Record<string, string | string[] | undefined> | undefined | null
): boolean {
  return headers?.[FEED_GO_PARITY_REPLAY_HEADER] !== undefined;
}
