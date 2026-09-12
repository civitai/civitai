import { describe, expect, it } from 'vitest';
import { REGISTERED_RECIPE_IDS, getRecipe } from '../index';
import {
  BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
} from '~/shared/constants/block-scope.constants';

/**
 * 🔴 WHY THIS EXISTS. `BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY` / `_HIGH_CEILING_PER_DAY`
 * are hand-mirrored from the recipe registry and are rendered VERBATIM to users in the
 * low-budget warning. Nothing enforced them, so registering an engine outside the pair
 * silently makes that user-facing sentence false — which is exactly the failure this
 * whole surface has now produced three times, each time in a new direction.
 *
 * The numbers are copy-only (no enforcement path reads them), so the remedy for a red
 * here is to UPDATE THE CONSTANTS and re-read the two warning strings — not to change
 * the recipe.
 *
 * Scope, stated honestly: this pins the bounds against the RECIPE (customComfy) path,
 * which is the only path that declares a per-engine `maxBuzz`. It says nothing about
 * `textToImage`, whose reservation is the live whatIf quote — which is why the warning
 * copy is hedged rather than categorical.
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

  it('no registered engine falls outside the pair the warning quotes', () => {
    const outside = ceilings.filter(
      (c) =>
        c.maxBuzz < BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY ||
        c.maxBuzz > BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY
    );
    expect(
      outside.map((c) => `${c.id}/${c.engine}=${c.maxBuzz}`),
      'these engines are outside the range the user-facing warning names'
    ).toEqual([]);
  });
});
