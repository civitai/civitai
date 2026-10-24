import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE_ACTIVITY_OR } from '~/server/services/blocks/scope-activity-predicate';

/**
 * 🔴 THE SHAPE OF THE SHARED SCOPE-ACTIVITY PREDICATE. The two call sites that must agree —
 * `blocks.getNavSummary`'s `hasActivity` probe (does the viewer get an Activity TAB?) and
 * `listMyScopeInvocations` (what does that tab CONTAIN?) — are pinned by IDENTITY in their own
 * suites, not here:
 *   · `blocks.router.getNavSummary.test.ts` → `expect(where.OR).toBe(GLOBAL_SCOPE_ACTIVITY_OR.OR)`
 *   · `user-app-surface.orchestration.test.ts` → the same `toBe` on the feed's `where.OR`
 * This file only pins what the constant MEANS.
 *
 * 🔴 IT USED TO TRY TO DO BOTH JOBS, AND THE SECOND ONE WAS WALKABLE — recorded because the
 * replacement is the lesson. It asserted that the string `GLOBAL_SCOPE_ACTIVITY_OR` appeared
 * somewhere in `blocks.router.ts` and that a 29-character literal did not. An audit walked it
 * in one edit: swap the spread for a differently-spelled divergent predicate, leave the symbol
 * alive in a COMMENT, update the router test's own literal — and **67/67 stayed green** while
 * the probe and the feed diverged, silently restoring the no-tab defect this change exists to
 * fix. A guard on WORDS is satisfied by re-wording; only a guard on the VALUE that reached
 * Prisma can tell "read the shared constant" from "re-spelled the same clause". Hence `toBe`,
 * in the suites that can observe the actual call, and no file-scanning here.
 */
describe('🔴 the shared scope-activity predicate', () => {
  it('is a non-empty OR over exactly the two columns that mark an in-platform row', () => {
    // Structural rather than a spelling: an external-OAuth row carries NEITHER column, so an
    // OR over exactly these two is what excludes it. Asserting the shape rather than copying
    // the clause keeps this from becoming a third literal to drift against.
    expect(Array.isArray(GLOBAL_SCOPE_ACTIVITY_OR.OR)).toBe(true);
    expect(GLOBAL_SCOPE_ACTIVITY_OR.OR.length).toBeGreaterThan(0);

    const columns = GLOBAL_SCOPE_ACTIVITY_OR.OR.map((clause) => Object.keys(clause)[0]).sort();
    expect(columns).toEqual(['appBlockId', 'syntheticAppId']);

    // Every disjunct must be an EXISTENCE test. `{ appBlockId: someValue }` would narrow the
    // feed to a single app while still satisfying a key-name check.
    for (const clause of GLOBAL_SCOPE_ACTIVITY_OR.OR) {
      expect(Object.values(clause)[0]).toEqual({ not: null });
    }
  });

  it('lives in a LEAF module — importing it must not drag a service into a caller graph', async () => {
    // 🔴 THIS IS WHY THE CONSTANT MOVED. It briefly lived in `user-app-surface.service.ts`,
    // which put that heavy service into `blocks.router.ts`'s STATIC import graph — the exact
    // thing that router's five `await import(…)` sites exist to avoid, and which four router
    // suites' one-key `vi.mock` factories would have tripped over. A leaf module whose only
    // import is TYPE-ONLY costs nothing at runtime.
    const fs = await import('fs/promises');
    const path = await import('path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../scope-activity-predicate.ts'),
      'utf8'
    );

    // Positive control: the file was actually read and holds the constant.
    expect(src, 'the leaf module does not define the constant').toContain(
      'GLOBAL_SCOPE_ACTIVITY_OR'
    );

    // Every import in it must be type-only, so nothing here can reach a runtime graph.
    const imports = [...src.matchAll(/^import\s+(type\s+)?/gm)];
    expect(imports.length, 'the leaf module has no imports to classify').toBeGreaterThan(0);
    for (const m of imports) {
      expect(m[1], `a VALUE import in the leaf module: ${m[0].trim()}`).toBeTruthy();
    }
  });
});
