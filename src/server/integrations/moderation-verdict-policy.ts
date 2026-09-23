// The policy that reduces ONE raw classifier result to the verdict this app acts on.
//
// 🔴 IT LIVES IN ITS OWN MODULE SO TWO CALLERS CANNOT DRIFT. `moderation.ts` applies it to the
// incumbent model's response; `moderation-shadow-probe.ts` applies it to a candidate model's. A
// shadow comparison that re-implemented this would compare a policy-applied verdict against a raw
// one and report the POLICY's effect as the candidate MODEL's disagreement — a wrong answer that
// looks entirely plausible. Same rule the model literal already follows in `moderation.ts`: one
// spelling, one place.
//
// A separate module rather than an export from `moderation.ts` because the probe is imported BY
// `moderation.ts`; importing back would be a cycle, and reaching for a lazy `import()` to dodge the
// cycle would trade a structural problem for a timing one.

/**
 * Reduce one raw classifier result to `{ flagged, categories }`.
 *
 * Threshold mode (no `categoryMap`): every category whose score exceeds `threshold` is reported,
 * and `flagged` is whatever the classifier itself said. Category mode (`categoryMap` present):
 * the map REPLACES that entirely — only mapped categories the classifier marked true are reported,
 * each renamed to its mapped value, and `flagged` becomes "any of them matched".
 *
 * ⚠️ BEHAVIOUR-PRESERVING EXTRACTION FROM `moderation.ts`, NOT A REWRITE. `RawClassifierResult`
 * is a COMPILE-TIME shape only: the value arrives from `res.json()`, so at runtime `flagged` is
 * whatever the vendor actually sent and nothing here coerces or validates it. The annotation
 * describes the contract, it does not enforce it — a consumer that needs a strict boolean must
 * coerce at its own comparison site (`moderation-shadow-probe.ts` does exactly that, and says why).
 * If you are tempted to tighten this into real validation, read the header on
 * `extModeration.moderatePrompt` first: widening this return type is how a real bug was once found,
 * and narrowing it again is how one would be reintroduced. Consumers that need a strict boolean
 * should coerce at their own comparison site.
 */
export type RawClassifierResult = {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
};

export function deriveModerationVerdict(
  result: RawClassifierResult,
  threshold: number,
  categoryMap: Record<string, string> | undefined
): { flagged: boolean; categories: string[] } {
  let flagged = result.flagged;
  let categories = Object.entries(result.category_scores)
    .filter(([, v]) => (v as number) > threshold)
    .map(([k]) => k);

  // If we have categories
  // Only flag if any of them are found in the results
  if (categoryMap) {
    categories = [];
    for (const [k, v] of Object.entries(categoryMap)) {
      if (result.categories[k]) categories.push(v ?? k);
    }
    flagged = categories.length > 0;
  }

  return { flagged, categories };
}
