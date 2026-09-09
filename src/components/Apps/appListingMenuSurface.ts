/**
 * App Store Listings — WHICH SURFACE the shared `⋮` menu is being rendered on, and
 * the one thing that answer is allowed to change.
 *
 * Pure + React-free so the correctness gate lives in the blocking node `unit` project
 * (the `.browser.test.tsx` component suites are report-only), mirroring its siblings
 * `appListingDetailModActions` / `appListingCardView`.
 *
 * 🔴 WHY THIS EXISTS AT ALL, GIVEN THAT `AppListingActionsMenu` WAS WRITTEN TO MAKE
 * THE TWO SURFACES IDENTICAL. Because one difference between them is real and the
 * rest are not. The listing DETAIL page is a page the viewer chose to open about one
 * app: offering them "Leave a review" and "Report" there is the point of the page.
 * The store CARD is one of ~24 tiles in a grid the viewer is scanning, and the same
 * two items on it are an invitation to review an app they have not opened. So the
 * card offers only the items that are about ACTING ON YOUR OWN THING — the owner's
 * Edit and the moderator section — and the viewer actions stay on the detail page.
 *
 * 🔴 THE POLICY LIVES HERE RATHER THAN AT THE CALL SITES, WHICH IS THE WHOLE POINT
 * OF THE SHAPE. A boolean prop (`viewerActions={false}`) would put the POLICY in
 * each call site, so a third surface would spell its own answer and the two could
 * disagree — a predicate duplicated across call sites, which is precisely the drift
 * `AppListingActionsMenu` was extracted to end. A `surface` name puts the call site
 * in charge of saying WHERE it is and this module in charge of saying WHAT THAT
 * MEANS, so the difference between the surfaces is auditable in one place.
 */

/** The surfaces that render `AppListingActionsMenu`. Closed on purpose. */
export const APP_LISTING_MENU_SURFACES = ['card', 'detail'] as const;
export type AppListingMenuSurface = (typeof APP_LISTING_MENU_SURFACES)[number];

/**
 * The surfaces that offer the VIEWER actions — "Leave a review" and "Report".
 *
 * 🔴 A `Set` OF THE ADMITTING SURFACES, NOT A `Record<Surface, boolean>` LOOKUP, AND
 * THE DIFFERENCE IS THE FAILURE DIRECTION. A record indexed by a key that did not
 * come from the union — `surface` is a prop, and a JS caller is not type-checked —
 * resolves inherited members: `table['toString']` is a function, i.e. TRUTHY, so an
 * unknown surface would be granted the viewer actions. `Set.has` answers false for
 * every key it was not given, so an unknown surface gets the NARROWER menu. That is
 * the same fails-open shape this repo has been bitten by before (civitai#3495).
 */
const VIEWER_ACTION_SURFACES: ReadonlySet<AppListingMenuSurface> = new Set(['detail']);

/**
 * May this surface offer "Leave a review" / "Report" to an ordinary signed-in viewer?
 *
 * 🔴 THIS IS A SURFACE GATE, NOT AN ELIGIBILITY GATE, and it is the NARROWER of the
 * two by construction: it is `&&`-ed with `useCanReviewListing` / `useCanReportListing`
 * rather than replacing either, so it can only ever REMOVE an item that those
 * predicates already admitted. Nothing here can hand an action to a viewer the
 * affordance's own rule refuses, and neither can it reach the server gate, which is
 * the real boundary in both cases.
 */
export function surfaceOffersViewerActions(surface: AppListingMenuSurface): boolean {
  return VIEWER_ACTION_SURFACES.has(surface);
}
