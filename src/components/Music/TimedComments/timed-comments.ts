/** How long a timed comment's label shows once the playhead reaches it. */
export const TIMED_COMMENT_LABEL_SEC = 4;

type Timed = { timestampSec: number };

/** Comments whose avatars would overlap on the waveform, shown as one stack at the first one's time. */
export type TimedCommentCluster<T extends Timed> = { timestampSec: number; comments: T[] };

/**
 * Groups `comments` (ordered by time) into clusters: a comment joins the one before it when their
 * avatars, `avatarPx` wide on a waveform `widthPx` wide for a song `duration` long, would overlap.
 */
export function clusterTimedComments<T extends Timed>(
  comments: T[],
  duration: number,
  widthPx: number,
  avatarPx: number
): TimedCommentCluster<T>[] {
  const pxPerSec = duration > 0 ? widthPx / duration : 0;
  const clusters: TimedCommentCluster<T>[] = [];
  for (const comment of comments) {
    const last = clusters[clusters.length - 1];
    const previous = last?.comments[last.comments.length - 1];
    if (
      previous &&
      pxPerSec > 0 &&
      (comment.timestampSec - previous.timestampSec) * pxPerSec < avatarPx
    )
      last.comments.push(comment);
    else clusters.push({ timestampSec: comment.timestampSec, comments: [comment] });
  }
  return clusters;
}

/**
 * The comment whose label shows at `currentTime`. Each label shows for `TIMED_COMMENT_LABEL_SEC`
 * from its time; inside a cluster the next one waits for the one before, so a reached cluster shows
 * its comments one after another. Across clusters the latest one reached wins.
 */
export function activeTimedComment<T extends Timed>(
  clusters: TimedCommentCluster<T>[],
  currentTime: number
): T | undefined {
  let active: T | undefined;
  for (const cluster of clusters) {
    if (cluster.timestampSec > currentTime) break;
    let start = -Infinity;
    for (const comment of cluster.comments) {
      start = Math.max(comment.timestampSec, start + TIMED_COMMENT_LABEL_SEC);
      if (start > currentTime) break;
      if (currentTime - start < TIMED_COMMENT_LABEL_SEC) active = comment;
    }
  }
  return active;
}
