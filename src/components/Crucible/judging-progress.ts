/**
 * What the judging footer shows. `totalPairs` is the most pairs the judge can reach, less those
 * their votes settled, so "to go" falls by one per vote, or by more when a vote settles other pairs,
 * and stays above zero while pairs are still served. `votesUsedUp` (the server's "no pairs left
 * among entries you can see") collapses the total to what the judge voted, rather than leaving a
 * count that can't be cleared. Zero pairs because the browsing level hides entries is not that, so
 * it stays unfinished.
 */
export function getPairProgress({
  judgedPairs,
  totalPairs,
  votesUsedUp,
}: {
  judgedPairs: number;
  totalPairs: number;
  votesUsedUp: boolean;
}) {
  const finished = votesUsedUp && judgedPairs > 0;
  const total = finished ? judgedPairs : Math.max(totalPairs, judgedPairs);
  return {
    total,
    toGo: Math.max(0, total - judgedPairs),
    percent: total ? Math.min(100, (judgedPairs / total) * 100) : 0,
    finished,
  };
}
