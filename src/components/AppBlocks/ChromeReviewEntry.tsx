import { Button } from '@mantine/core';
import { IconThumbUp } from '@tabler/icons-react';

import { useCanReviewListing } from '~/components/Apps/ReviewListingButton';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';
import { ChromeSurfaceItem } from './ChromeSurface';
import { useChromeListingDetail } from './useChromeListingDetail';

/**
 * F4 — the app-block host chrome's REVIEW ENTRY POINTS.
 *
 * Until now the only way to review an app was to already be standing on its store
 * listing. The one place a user is guaranteed to have an opinion about an app is
 * while the app is running in front of them, and that surface offered nothing. This
 * module supplies the two affordances the chrome mounts — an item in the ⋮ overflow
 * menu and an action in the app-name popover — both of which open the SAME existing
 * `ReviewListingModal`.
 *
 * 🔴 IT BUILDS NO REVIEW SYSTEM. The gate (`useCanReviewListing`), the form and the
 * mutation (`ReviewListingModal`) already exist and are imported, not re-derived.
 * The review model is thumbs + free text (`recommended` / `details`); there are no
 * stars anywhere in this path.
 *
 * 🔴 NEITHER ENTRY POINT OWNS THE MODAL, AND THAT IS FORCED, NOT STYLISTIC. Mantine
 * unmounts a `Menu.Dropdown` and a `Popover.Dropdown` when they close, so a modal
 * rendered beside its trigger would be destroyed by the very click that opens it —
 * the same constraint that made `ReviewListingModal` a caller-controlled component
 * in the first place, and the reason `AppListingDetailBody` owns its copy too. Both
 * components here take an `onOpenReview(appListingId)` and hand the id UP to
 * `AppBlockChrome`, which mounts the modal outside every floating surface.
 *
 * 🔴 EACH ENTRY POINT CLOSES ITS OWN OPENER. A dropdown left hanging behind a modal
 * is the visible half of the defect F0 fixed (`useIframeAwareMenu`), and it is worse
 * here than a stray dropdown: the modal takes focus while the menu keeps its
 * `aria-expanded="true"`. The ⋮ item gets that for free from Mantine
 * (`closeOnItemClick` runs `closeDropdownImmediately`, which in a CONTROLLED menu
 * calls our `onChange(false)` — verified against @mantine/core 7.17.8
 * `Menu/MenuItem/MenuItem.mjs` and pinned behaviourally in
 * `ChromeReviewEntry.browser.test.tsx`); the popover action has no such default and
 * closes itself explicitly.
 *
 * 🔴 F3 — THE ⋮ ITEM IS A `ChromeSurfaceItem`, NOT A `Menu.Item`, AND THAT IS WHAT
 * MAKES IT WORK ON THE MOBILE SHELL. Below `sm` the ⋮ overflow is a bottom sheet, and
 * a `Menu.Item` calls `useMenuContext()` — which THROWS outside a `<Menu>`. So this
 * item could not simply be re-parented; the primitive renders a `Menu.Item` in a
 * dropdown and a sheet row otherwise, and supplies the close on the sheet side that
 * Mantine supplies on the menu side. Nothing about the GATES moved: the same
 * `hasAppsStoreAccess` + `useCanReviewListing` chain decides whether this renders at
 * all, in both surfaces.
 */

/**
 * The label for a review entry point: "Rate this app" for a viewer who has not
 * reviewed, "Edit your review" for one who has.
 *
 * 🔴 A SEPARATE HOOK SO THE TWO ENTRY POINTS CANNOT DISAGREE. They sit a few pixels
 * apart in one bar; one saying "Rate this app" while the other says "Edit your
 * review" would be a straightforward lie about the viewer's own state. Same query,
 * same input, so React Query serves both from one cache entry.
 *
 * The query is mounted only by an ELIGIBLE viewer's entry point (both call sites sit
 * behind `useCanReviewListing`), so an ineligible or signed-out viewer never issues
 * it — `getMyReview` is a protected procedure.
 */
export function useChromeReviewLabel(appListingId: string): string {
  const { data: myReview } = trpc.appListings.getMyReview.useQuery({ appListingId });
  return myReview ? 'Edit your review' : 'Rate this app';
}

/**
 * The ⋮ overflow-menu item. Renders `null` for a viewer the server would refuse.
 *
 * 🔴 THE GATE IS SPLIT ACROSS TWO COMPONENTS BECAUSE THE RULES OF HOOKS MAKE A
 * ONE-COMPONENT VERSION FIRE THE QUERY ANYWAY. An `if (!eligible) return null` above
 * a `useQuery` is not legal, and an `enabled:` flag is a rule someone has to keep
 * correct. Mounting the query-bearing half only once the cheap synchronous gates
 * (store access, a threaded slug) have passed makes the laziness structural — the
 * same split F2 used for `AppNameCrumb` → `AppNameCrumbCard`, and for the same
 * measured reason: a hook instantiated on every chrome render reaches contexts the
 * chrome does not own.
 *
 * 🔴 THE STORE-ACCESS TERM IS `hasAppsStoreAccess`, READ THROUGH
 * `useOptionalFeatureFlags`. `useFeatureFlags` THROWS outside its provider, and this
 * chrome is deliberately renderable in isolation; the optional hook returns `null`
 * there and `hasAppsStoreAccess(null)` is `false`, so missing flags REMOVE the
 * affordance rather than granting it. It is the same predicate the store itself
 * gates on, which matters because `getAppDetail` resolves a `none` scope for this
 * cohort and throws NOT_FOUND — an item here would open a modal that can never load.
 */
export function ChromeReviewMenuItem({
  slug,
  onOpenReview,
}: {
  /** The app's STORE slug (`AppListing.slug`). Omitted → no entry point. */
  slug: string | undefined;
  onOpenReview: (appListingId: string) => void;
}) {
  const features = useOptionalFeatureFlags();
  if (!slug || !hasAppsStoreAccess(features)) return null;
  return <ChromeReviewMenuItemBody slug={slug} onOpenReview={onOpenReview} />;
}

function ChromeReviewMenuItemBody({
  slug,
  onOpenReview,
}: {
  slug: string;
  onOpenReview: (appListingId: string) => void;
}) {
  const { detail } = useChromeListingDetail(slug);
  // `creator` is the listing owner chip; a self-review is 403'd server-side, so the
  // affordance is withheld from the owner rather than offered and refused. `kind` is
  // the store-scope term — an external-only viewer must not be offered a control on
  // an onsite listing the server will NOT_FOUND (and vice versa).
  const canReview = useCanReviewListing({
    ownerUserId: detail?.creator?.id ?? null,
    listingKind: detail?.kind,
  });
  // No listing row yet (in flight, 404, scope-gated) → nothing to review. The item
  // appears when the data arrives; it is never rendered against a listing id we do
  // not have, which is what would produce a modal whose submit 403s.
  if (!detail || !canReview) return null;
  return <ChromeReviewMenuItemLabelled appListingId={detail.id} onOpenReview={onOpenReview} />;
}

function ChromeReviewMenuItemLabelled({
  appListingId,
  onOpenReview,
}: {
  appListingId: string;
  onOpenReview: (appListingId: string) => void;
}) {
  const label = useChromeReviewLabel(appListingId);
  return (
    <ChromeSurfaceItem
      leftSection={<IconThumbUp size={14} stroke={1.5} />}
      onClick={() => onOpenReview(appListingId)}
      data-testid="app-block-review-menu-item"
    >
      {label}
    </ChromeSurfaceItem>
  );
}

/**
 * The app-name popover's review action, rendered beside "View in App Store".
 *
 * Takes the ALREADY-RESOLVED `detail` rather than re-reading it: the popover card
 * only renders this on its success branch, so it has the row in hand. One less
 * observer on the query, and — more to the point — it cannot key the read
 * differently from its own parent.
 */
export function ChromeReviewPopoverAction({
  detail,
  onOpenReview,
}: {
  detail: ListingDetail;
  /** Called with the listing id. The caller closes the popover; see the module header. */
  onOpenReview: (appListingId: string) => void;
}) {
  const canReview = useCanReviewListing({
    ownerUserId: detail.creator?.id ?? null,
    listingKind: detail.kind,
  });
  if (!canReview) return null;
  return <ChromeReviewPopoverButton appListingId={detail.id} onOpenReview={onOpenReview} />;
}

function ChromeReviewPopoverButton({
  appListingId,
  onOpenReview,
}: {
  appListingId: string;
  onOpenReview: (appListingId: string) => void;
}) {
  const label = useChromeReviewLabel(appListingId);
  return (
    <Button
      size="xs"
      variant="subtle"
      leftSection={<IconThumbUp size={14} stroke={1.5} />}
      onClick={() => onOpenReview(appListingId)}
      data-testid="app-block-name-popover-review"
    >
      {label}
    </Button>
  );
}
