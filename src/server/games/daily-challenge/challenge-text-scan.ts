// Which XGuard labels escalate a challenge, and the score at which they do.
//
// `nsfw` alone at its registry threshold of 0.75 caught 1 of 10 adult challenges when every
// challenge in the corpus (214) was replayed through the scanner. Challenge text is a title and a
// theme — keywords, never prose — and the NSFW policy asks for "explicit sexual content or graphic
// sexual description", so bare topical text ("sex", "furry butts") lands at 0.55-0.73 and never
// reaches 0.75. Adding `explicit` and scoring both at 0.5 took the same corpus to 9 of 10 with no
// false positives.
//
// `suggestive` is deliberately excluded despite catching the tenth: it fires at 0.51-0.65 on
// "Fractal Geometry", "Rainbow Unicorn" and "Psychedelic Dreams" — 40 false positives in that
// backtest. It is fine for wildcard categories, where a trigger flips a boolean; here a trigger
// voids a green challenge and refunds Buzz, so precision matters more.
export const CHALLENGE_MODERATION_LABELS = ['nsfw', 'explicit'] as const;
export const CHALLENGE_NSFW_SCORE_THRESHOLD = 0.5;

const ESCALATING_LABELS: ReadonlySet<string> = new Set(CHALLENGE_MODERATION_LABELS);

type ScanLabelResult = { label?: string | null; score?: number | null };

/**
 * Whether a challenge's scanned text counts as adult content.
 *
 * Scores are read directly rather than relying on the pipeline's `triggeredLabels`, because those
 * are computed against the global per-label thresholds shared with articles and wildcard
 * categories. Challenges need a stricter bar than the registry's 0.75 for `nsfw` without moving it
 * for every other consumer.
 */
export function isChallengeTextNsfw({
  results,
  triggeredLabels = [],
}: {
  results?: ScanLabelResult[] | null;
  triggeredLabels?: string[];
}): boolean {
  if (triggeredLabels.some((label) => ESCALATING_LABELS.has(label.toLowerCase()))) return true;

  return (results ?? []).some(
    (result) =>
      !!result?.label &&
      ESCALATING_LABELS.has(result.label.toLowerCase()) &&
      (result.score ?? 0) >= CHALLENGE_NSFW_SCORE_THRESHOLD
  );
}
