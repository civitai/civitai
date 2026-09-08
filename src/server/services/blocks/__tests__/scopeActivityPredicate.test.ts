import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE_ACTIVITY_OR } from '~/server/services/blocks/user-app-surface.service';

/**
 * 🔴 THE SEAM BETWEEN `getNavSummary`'s `hasActivity` PROBE AND THE ACTIVITY FEED ITSELF.
 *
 * The nav probe decides whether a viewer is offered an Activity TAB; the feed decides what that
 * tab CONTAINS. They must agree about which scope-invocation rows count as activity, or one of
 * two defects ships:
 *   · probe wider than feed  → a tab over a page reading "No activity yet";
 *   · probe narrower than feed → the no-tab bug this PR exists to fix, silently restored.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE TWO-COPY VERSION WAS DEMONSTRATED TO DRIFT SILENTLY, not
 * argued to. Both sides previously asserted their own `where` against a hand-copied literal in
 * their own suite. An audit tightened the FEED's clause and updated the FEED's own literal —
 * exactly the edit a developer making that change would make — and **both suites stayed green,
 * 65/65**, while the probe over-matched. Neither guard could see the other move. That is the
 * "docstring names a RELATIONSHIP, body inspects one SIDE" shape.
 *
 * 🔴 SO THE FIX IS THE EXPORT, AND THIS FILE ONLY PINS THAT THE EXPORT IS WHAT BOTH SIDES READ.
 * `GLOBAL_SCOPE_ACTIVITY_OR` now lives once in `user-app-surface.service.ts`; the feed spreads
 * it and `blocks.router.ts` imports it. Change the predicate there and BOTH move by
 * construction — which is a stronger guarantee than any assertion, and is why the test below
 * deliberately does NOT re-spell the clause as a third literal. A third copy would recreate the
 * very defect this closes.
 */
describe('🔴 the scope-activity predicate is single-sourced', () => {
  it('is a non-empty OR over exactly the two columns that mark an in-platform row', () => {
    // Structural, not a spelling: an external-OAuth row carries NEITHER column, so an OR over
    // these two is what excludes it. Asserting the SHAPE rather than a copied literal keeps
    // this from becoming the third copy.
    expect(Array.isArray(GLOBAL_SCOPE_ACTIVITY_OR.OR)).toBe(true);
    expect(GLOBAL_SCOPE_ACTIVITY_OR.OR.length).toBeGreaterThan(0);

    const columns = GLOBAL_SCOPE_ACTIVITY_OR.OR.map((clause) => Object.keys(clause)[0]).sort();
    expect(columns).toEqual(['appBlockId', 'syntheticAppId']);

    // Every disjunct must be an EXISTENCE test. `{ appBlockId: someValue }` would silently
    // narrow the feed to one app while still passing a key-name check.
    for (const clause of GLOBAL_SCOPE_ACTIVITY_OR.OR) {
      expect(Object.values(clause)[0]).toEqual({ not: null });
    }
  });

  it('🔴 both call sites READ this symbol rather than re-spelling the clause', async () => {
    // The guarantee is structural — one exported object, two importers — so what this pins is
    // that neither side has quietly reintroduced its own copy. A literal `OR: [{ appBlockId`
    // in either file is that regression, and it is what this asserts against.
    const fs = await import('fs/promises');
    const path = await import('path');
    const root = path.resolve(__dirname, '../../../..'); // -> src/

    const router = await fs.readFile(path.join(root, 'server/routers/blocks.router.ts'), 'utf8');
    const service = await fs.readFile(
      path.join(root, 'server/services/blocks/user-app-surface.service.ts'),
      'utf8'
    );

    // Positive control: the symbol is genuinely present in both, so a zero below is a real
    // absence rather than a mis-typed path or an unread file.
    expect(router, 'the router does not reference the shared predicate at all').toContain(
      'GLOBAL_SCOPE_ACTIVITY_OR'
    );
    expect(service, 'the service does not reference the shared predicate at all').toContain(
      'GLOBAL_SCOPE_ACTIVITY_OR'
    );

    // The router must not carry its own spelling of the clause.
    expect(
      router.includes('{ appBlockId: { not: null } }'),
      'blocks.router.ts re-spells the scope-activity OR instead of importing GLOBAL_SCOPE_ACTIVITY_OR — that is the second copy whose drift is silent'
    ).toBe(false);

    // The service may spell it EXACTLY ONCE — inside the exported constant itself.
    const spellings = [...service.matchAll(/\{ appBlockId: \{ not: null \} \}/g)].length;
    expect(
      spellings,
      'the scope-activity OR is spelled more than once in the service — the export should be its only definition'
    ).toBe(1);
  });
});
