/** How long a timed comment's label shows once the playhead reaches it. */
export const TIMED_COMMENT_LABEL_SEC = 4;

/**
 * The comment whose label shows at `currentTime`: the latest one the playhead has reached in the
 * last `TIMED_COMMENT_LABEL_SEC`, so a newer one replaces it. `comments` are ordered by time.
 */
export function activeTimedComment<T extends { timestampSec: number }>(
  comments: T[],
  currentTime: number
): T | undefined {
  let active: T | undefined;
  for (const comment of comments) {
    if (comment.timestampSec > currentTime) break;
    if (currentTime - comment.timestampSec < TIMED_COMMENT_LABEL_SEC) active = comment;
  }
  return active;
}
