/**
 * What the judging footer shows. `totalPairs` is stable across votes, so "to go" falls by one per
 * vote. Once `remainingPairs` hits zero the judge has run out of votes or pairs before reaching the
 * total, so the total collapses to what they judged rather than leaving a count that can't be cleared.
 */
export function getPairProgress({
  judgedPairs,
  totalPairs,
  remainingPairs,
}: {
  judgedPairs: number;
  totalPairs: number;
  remainingPairs: number;
}) {
  const finished = remainingPairs === 0 && judgedPairs > 0;
  const total = finished ? judgedPairs : Math.max(totalPairs, judgedPairs);
  return {
    total,
    toGo: Math.max(0, total - judgedPairs),
    percent: total ? Math.min(100, (judgedPairs / total) * 100) : 0,
    finished,
  };
}
