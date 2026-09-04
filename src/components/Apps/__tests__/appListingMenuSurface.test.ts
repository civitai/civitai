import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  APP_LISTING_MENU_SURFACES,
  surfaceOffersViewerActions,
} from '~/components/Apps/appListingMenuSurface';

/**
 * App Store Listings — the `⋮` menu's SURFACE policy (node `unit` project → the
 * BLOCKING correctness gate).
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL, WHEN THE BEHAVIOUR IS ALREADY ASSERTED IN TWO
 * BROWSER SUITES. Because those suites are REPORT-ONLY. `*.browser.test.tsx` runs in
 * the `component` project, which CI reaches only through the PR-preview pipeline's
 * `preview / component-tests` task — non-blocking, gated on the `preview` label, and
 * not reported at all when the preview build fails. `.github/workflows/lint.yml`'s
 * `Unit tests` job runs `--project 'unit*'`, whose include is `src/**\/*.test.ts`:
 * `.tsx` is not in it. So the real rendered assertions — a signed-in shopper gets no
 * card menu, the same shopper still gets Review/Report on the detail page — can go
 * red without blocking anything. This file re-states the parts of that claim a node
 * test CAN hold, in the tier that blocks.
 *
 * 🔴 WHAT IT THEREFORE CANNOT SEE, stated rather than implied: it renders nothing. It
 * cannot tell you that the card's action row is 138px wide, that the menu trigger is
 * absent from the DOM, or that `useAppListingMenuGates` actually consults this module
 * — only that the policy says what it should and that both call sites spell a
 * surface. The rendered claims are made in `AppListingCard.browser.test.tsx` and
 * `AppListingDetailBody.browser.test.tsx`.
 */
describe('the listing menu surface policy', () => {
  it('the card does NOT offer the viewer actions and the detail page DOES', () => {
    // Both directions, because a policy that answered `false` for everything would
    // satisfy the card half alone — and it would silently strip Review and Report
    // from the one surface whose job is to offer them.
    expect(surfaceOffersViewerActions('card')).toBe(false);
    expect(surfaceOffersViewerActions('detail')).toBe(true);
  });

  it('every declared surface has an answer, and the set is exactly the two call sites', () => {
    expect([...APP_LISTING_MENU_SURFACES]).toEqual(['card', 'detail']);
    // A surface added to the union without a decision here would otherwise inherit
    // whatever the lookup happens to do — see the fails-closed assertion below.
    for (const surface of APP_LISTING_MENU_SURFACES) {
      expect(typeof surfaceOffersViewerActions(surface)).toBe('boolean');
    }
  });

  /**
   * 🔴 THE FAILURE DIRECTION, ASSERTED RATHER THAN TRUSTED TO THE TYPE. `surface` is
   * a prop, and a prop is not type-checked at runtime — a JS caller, a stale build,
   * or a value round-tripped through JSON can hand this function anything. A
   * `Record<Surface, boolean>` lookup would resolve `'toString'` to a FUNCTION, i.e.
   * truthy, and grant the viewer actions to a surface nobody decided about; the
   * implementation uses a `Set`, which answers false for every key it was not given.
   *
   * Prototype keys specifically, because that is the shape this repo has been bitten
   * by before (civitai#3495) and the one a plain "unknown string" case does not
   * exercise: `'nope'` is absent from an object literal too, so it would pass against
   * the broken implementation and prove nothing.
   */
  it('an unknown surface fails CLOSED, prototype keys included', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'nope', '']) {
      expect(surfaceOffersViewerActions(key as never), `surface ${JSON.stringify(key)}`).toBe(
        false
      );
    }
  });

  /**
   * 🔴 THE CALL SITES, READ FROM SOURCE. The policy above is only worth anything if
   * the two surfaces actually pass the string this module expects — and the wrong
   * one is not a type error, because both are members of the same union. A card that
   * said `surface="detail"` would type-check perfectly and re-introduce the exact
   * regression this change removes.
   */
  describe('the call sites name their own surface', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    /**
     * Comments are not code. Both modules discuss the OTHER surface by name in prose
     * — the card's action-row note explains why the detail page keeps these items —
     * so a raw `toContain` on the source text would pass against a file whose actual
     * JSX says nothing at all. Same stripper as `appListingCardView.test.ts`.
     */
    const code = (rel: string) =>
      read(rel)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('AppListingCard renders the menu with surface="card", and lays out the same either way', () => {
      const card = code('../AppListingCard.tsx');
      expect(card).toContain('surface="card"');
      expect(card).not.toContain('surface="detail"');
      // 🔴 THIS USED TO ALSO REQUIRE A `useAppListingActionsMenuVisible(menuTarget,
      // 'card')` CALL, AND THAT REQUIREMENT IS RETIRED RATHER THAN RELAXED. The card
      // asked the hook whether the trigger would take up row space, because the answer
      // decided a container query on the recommend rollup: a card laying out for the
      // wrong surface reserved 36px for a control it did not render. The rollup has
      // moved to the meta block, the query is gone, and the card's layout is now
      // IDENTICAL whether or not a `⋮` renders — so the coupling the old assertion
      // protected has no shape left to take.
      //
      // 🔴 SO THE ABSENCE IS ASSERTED INSTEAD, because "the card does not branch its
      // layout on menu visibility" is the property that replaced it. Re-introducing
      // that predicate is how the deleted apparatus comes back — and it would come
      // back silently, since nothing else reads it.
      expect(
        card,
        'AppListingCard branches its layout on menu visibility again — the rollup lives in the meta block now, so it should not need to'
      ).not.toContain('useAppListingActionsMenuVisible');
      // Positive control on the stripper: it did not simply eat the file, AND the
      // surface prop above is still reaching a real render.
      expect(card).toContain('AppListingActionsMenu');
      // …and the hook itself is still exported for the surfaces that DO need it, so
      // the absence above is a fact about this card, not about a deleted module.
      expect(code('../AppListingActionsMenu.tsx')).toContain(
        'export function useAppListingActionsMenuVisible'
      );
    });

    it('AppListingDetailBody renders the menu with surface="detail"', () => {
      const detail = code('../AppListingDetailBody.tsx');
      expect(detail).toContain('surface="detail"');
      expect(detail).not.toContain('surface="card"');
      expect(detail).toContain('AppListingActionsMenu');
    });

    /**
     * 🔴 A LEDGER, NOT A SPOT CHECK. The two assertions above are claims about two
     * files; this one is a claim about the SET. A third surface — a recents rail
     * tile, a modal header — that renders this menu without appearing here is the
     * case those two cannot see, and it is the case where the wrong default would do
     * damage. The prop is required precisely so `tsc` stops such a call site, and
     * this fails when the set GROWS or SHRINKS so the decision is re-made rather
     * than inherited.
     */
    it('exactly two modules render AppListingActionsMenu', () => {
      // 🔴 THE WHOLE OF `src`, NOT THIS DIRECTORY. A ledger scoped to the folder the
      // component lives in cannot see the case it exists for — a renderer added
      // somewhere else, which is where a surface nobody thought about would appear.
      const SRC = path.resolve(__dirname, '../../..');
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
            if (/<AppListingActionsMenu\b/.test(fs.readFileSync(full, 'utf8'))) {
              found.push(path.relative(SRC, full));
            }
          }
        }
      };
      walk(SRC);
      expect(found.sort()).toEqual([
        'components/Apps/AppListingCard.tsx',
        'components/Apps/AppListingDetailBody.tsx',
      ]);
    });
  });
});
