/**
 * Contract for the shared moderation VERDICT POLICY.
 *
 * WHY THIS FILE EXISTS. `deriveModerationVerdict` was extracted verbatim out of the inline body of
 * `extModeration.moderatePrompt` so that the shadow probe applies the SAME reduction to a candidate
 * model's response that the live path applies to the incumbent's. The extraction is only safe if it
 * is behaviour-preserving, and "it still compiles" does not establish that.
 *
 * 🔴 EVERY EXPECTATION BELOW IS A LITERAL, DERIVED FROM THE POLICY'S STATED CONTRACT — never read
 * back out of the implementation. That is the point: a test whose expectation is computed the same
 * way the code computes it passes for any behaviour, including a wrong one.
 */
import { describe, expect, it } from 'vitest';

import { deriveModerationVerdict } from '~/server/integrations/moderation-verdict-policy';

const result = (over: Record<string, unknown> = {}) => ({
  flagged: false,
  categories: { violence: false, sexual: false, harassment: false },
  // Deliberately pairwise-distinct and NOT equal to the threshold used below, so a mutant that
  // hardcodes a literal or flips a comparison cannot land on the same answer by coincidence.
  category_scores: { violence: 0.42, sexual: 0.81, harassment: 0.07 },
  ...over,
});

describe('threshold mode (no category map)', () => {
  it('reports every category strictly ABOVE the threshold', () => {
    // 0.81 > 0.5; 0.42 and 0.07 are not. Literal expectation.
    expect(deriveModerationVerdict(result(), 0.5, undefined).categories).toEqual(['sexual']);
  });

  it('is strictly greater-than, not greater-or-equal, at the boundary', () => {
    // A score EXACTLY on the threshold must not be reported. This is the mutant `>=` would survive
    // if every fixture score sat away from the boundary.
    expect(deriveModerationVerdict(result(), 0.81, undefined).categories).toEqual([]);
    expect(deriveModerationVerdict(result(), 0.8, undefined).categories).toEqual(['sexual']);
  });

  it('passes the classifier`s own `flagged` through UNCHANGED', () => {
    // In threshold mode the app does not recompute `flagged` — it echoes the vendor. So a result
    // that the vendor did not flag stays unflagged even though a category cleared the threshold.
    expect(deriveModerationVerdict(result(), 0.5, undefined).flagged).toBe(false);
    expect(deriveModerationVerdict(result({ flagged: true }), 0.99, undefined).flagged).toBe(true);
  });
});

describe('category-map mode', () => {
  it('REPLACES the threshold result entirely and renames to the mapped value', () => {
    const verdict = deriveModerationVerdict(
      result({ categories: { violence: true, sexual: false, harassment: false } }),
      // A threshold that would report `sexual` in threshold mode — proving the map replaces rather
      // than intersects. `sexual` scores 0.81 and is NOT in the output below.
      0.5,
      { violence: 'graphic-violence' }
    );
    expect(verdict.categories).toEqual(['graphic-violence']);
    expect(verdict.flagged).toBe(true);
  });

  it('falls back to the KEY when the mapped value is nullish', () => {
    const verdict = deriveModerationVerdict(
      result({ categories: { violence: true } }),
      0.5,
      { violence: undefined as never }
    );
    expect(verdict.categories).toEqual(['violence']);
  });

  it('recomputes `flagged` from the matches, overriding the vendor', () => {
    // The vendor said flagged; no MAPPED category matched; the app un-flags it.
    const verdict = deriveModerationVerdict(
      result({ flagged: true, categories: { violence: false, sexual: true } }),
      0.5,
      { violence: 'graphic-violence' }
    );
    expect(verdict.flagged).toBe(false);
    expect(verdict.categories).toEqual([]);
  });

  it('ignores classifier categories that are not in the map', () => {
    const verdict = deriveModerationVerdict(
      result({ categories: { violence: false, sexual: true } }),
      0.5,
      { violence: 'graphic-violence' }
    );
    expect(verdict.flagged).toBe(false);
  });
});
