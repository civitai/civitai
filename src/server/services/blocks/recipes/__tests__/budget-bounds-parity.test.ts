import { describe, expect, it } from 'vitest';
import { REGISTERED_RECIPE_IDS, getRecipe } from '../index';
import {
  BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
} from '~/shared/constants/block-scope.constants';

/**
 * 🔴 WHY THIS EXISTS. `BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY` / `_HIGH_CEILING_PER_DAY`
 * are hand-mirrored from the recipe registry, and NEITHER IS RENDERED TO USERS. An
 * earlier revision of this paragraph said they were "rendered VERBATIM", which was true
 * when written and was falsified by the commit that stopped the copy quoting any figure
 * at all — the same shape as the five wordings this surface has already produced, which
 * is why it is being called out here rather than quietly corrected.
 *
 * 🔴 SO DO NOT READ A RED HERE AS "GO AND UPDATE A NUMBER IN THE COPY". The copy names
 * no number, and re-adding one is the relapse the rule at
 * `BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY` forbids. What is actually at stake:
 *   · `LOW` is the render THRESHOLD (`parsed < LOW`). If a cheaper engine is registered
 *     and LOW is left stale, the warning stops firing across the band between the old
 *     and new minimum — and "is a low limit" becomes wrong for values in it.
 *   · `HIGH` is tracked ONLY so a widening of the recipe range is noticed here.
 * The remedy for a red is to update the constants and re-read the threshold's meaning —
 * never to change the recipe, and never to put a figure back in the sentence.
 *
 * 🔴 SCOPE — FOUR THINGS THIS DOES NOT COVER. Stated in full because naming some gaps
 * and not the others reads as an exhaustive scope statement — an earlier revision said
 * "three" and omitted the STEP path (4), which is where the next false sentence then
 * appeared. It also cannot see a TIE: `LOW === min(...)` holds however many engines
 * share the minimum, and two of the four do, which falsified a "more on the others"
 * clause while these tests stayed green.
 *   1. `textToImage` — reserves the live whatIf quote, not a declared ceiling, and is
 *      not bounded below by LOW (the platform's per-gen default is 10).
 *   2. The INLINE `customComfy` arm — the app declares its own ceiling, up to
 *      `INLINE_MAX_BUZZ` = 250, which the router reserves verbatim. That is ABOVE the
 *      HIGH bound asserted here, and it is why the warning copy names no upper bound.
 *      Nothing in this file can see it; it is schema-bounded, not registry-bounded.
 *   3. `budgetFor(params)` — the router reserves THAT for the recipe arm, while this
 *      file reads `budgetForEngine(engine)`. Measured: replacing `budgetFor` with a
 *      400-Buzz stub leaves these four tests GREEN. The per-recipe suites
 *      (e.g. `seamless-pano.recipe.test.ts`) are what catch that, so a NEW recipe whose
 *      author skips its own suite is uncovered here. Also uncovered: a recipe
 *      registered with `engines: []` (the module-load invariant has the same hole).
 *   4. The STEP path — a step reserves `max(declaredBuzz, quotedBuzz)`, which is not a
 *      registry figure at all. `chat-completion`'s declared 1 is documented in
 *      `blocks.router.ts` as "that floor, not a price": measured several times the
 *      constant for an ordinary conversation, and rising with `maxTokens`. Nothing here
 *      or anywhere else pins it, which is why the warning copy makes no claim about
 *      whether step-based actions still run.
 */
describe('consent-budget copy bounds track the recipe registry', () => {
  /** Every (recipe, engine) pair's declared post-paid ceiling. */
  const ceilings = REGISTERED_RECIPE_IDS.flatMap((id) => {
    const recipe = getRecipe(id);
    if (!recipe) return [];
    return recipe.engines.map((engine) => ({
      id,
      engine,
      maxBuzz: recipe.budgetForEngine(engine).maxBuzz,
    }));
  });

  it('enumerates at least one ceiling (positive control — a zero here would pass every assertion below vacuously)', () => {
    expect(ceilings.length).toBeGreaterThan(0);
    // Guard the enumeration itself, not just its length: a registry that returned
    // undefined ceilings would still have a non-zero length.
    for (const c of ceilings) {
      expect(Number.isFinite(c.maxBuzz), `${c.id}/${c.engine} declared a non-finite maxBuzz`).toBe(
        true
      );
    }
  });

  it('LOW_WARN equals the lowest declared per-engine ceiling', () => {
    const lowest = Math.min(...ceilings.map((c) => c.maxBuzz));
    expect(
      BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
      `lowest declared ceiling is ${lowest} (${ceilings
        .filter((c) => c.maxBuzz === lowest)
        .map((c) => `${c.id}/${c.engine}`)
        .join(', ')}); update the constant and re-read the low-budget warning copy`
    ).toBe(lowest);
  });

  it('HIGH_CEILING equals the highest declared per-engine ceiling', () => {
    const highest = Math.max(...ceilings.map((c) => c.maxBuzz));
    expect(
      BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY,
      `highest declared ceiling is ${highest} (${ceilings
        .filter((c) => c.maxBuzz === highest)
        .map((c) => `${c.id}/${c.engine}`)
        .join(', ')}); update the constant and re-read the low-budget warning copy`
    ).toBe(highest);
  });

  it('no registered engine falls outside the tracked [LOW, HIGH] range', () => {
    const outside = ceilings.filter(
      (c) =>
        c.maxBuzz < BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY ||
        c.maxBuzz > BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY
    );
    expect(
      outside.map((c) => `${c.id}/${c.engine}=${c.maxBuzz}`),
      'these engines fall outside the tracked range; LOW is the warning THRESHOLD (so a ' +
        'value under it silently stops the warning firing) and HIGH is tracked only to ' +
        'notice a widening — HIGH is deliberately NOT rendered to users'
    ).toEqual([]);
  });
});
