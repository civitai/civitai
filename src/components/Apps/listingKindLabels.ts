import type { StoreListingKind } from '~/shared/utils/store-visibility-scope';

/**
 * 🔒 THE SINGLE SOURCE for the human-readable name of an App-store listing KIND.
 *
 * ## Why this module exists
 *
 * The store shipped the word **"Standalone"** for `kind='offsite'`, but the label
 * was hardcoded at each surface that rendered it — `AppBlockCard`'s badge and
 * `KindFilterButtons`' toggle said "Standalone" while the submit flow, the invites
 * table and the transfer-offers table still said "external app" / "External app".
 * One measured card carried BOTH: `SubmitModeSelector`'s title read "List an
 * external app (…)" directly above its own body text reading "List a standalone
 * app hosted elsewhere". A display rule open-coded at N sites is typically wrong at
 * N−1 of them, and unifying them is what makes the disagreement audible.
 *
 * ## 🔴 THIS IS A DISPLAY LABEL. IT IS NOT A VALUE.
 *
 * The stored/transported value stays `'onsite'` / `'offsite'` — the Prisma column,
 * the `/api/v1/apps` public response enum (a consumer-facing contract), the
 * `StoreListingKind` / `ListingKindFilter` unions, the `'public-external'` visibility
 * scope and the `app-listings-public-external` Flipt key are ALL untouched by this
 * module and must stay that way. Map for display at the render site; never rename
 * the value. `__tests__/standaloneWordingCallSites.test.ts` pins that constraint.
 *
 * ## 🔴 "On-site" is DELIBERATELY unchanged
 *
 * Renaming "On-site" → "Embedded" was considered and DEFERRED: "Embedded" collides
 * with "Embedding" (TextualInversion) one panel away in `AppSettingsModal`. This
 * module carries the on-site label only so both kinds resolve from one place — it is
 * not a licence to reword it.
 */

/** kind → the bare noun a human reads. */
export const LISTING_KIND_LABELS: Record<StoreListingKind, string> = {
  onsite: 'On-site',
  offsite: 'Standalone',
};

/** kind → the label as a full noun phrase ("… app"), for table cells and badges. */
export const LISTING_KIND_APP_LABELS: Record<StoreListingKind, string> = {
  onsite: 'On-site app',
  offsite: 'Standalone app',
};

/**
 * The offsite label on its own. Exported so prose that names the kind in a sentence
 * ("List a Standalone app hosted elsewhere") composes from the same constant the
 * badge uses, instead of re-typing the word.
 */
export const STANDALONE_KIND_LABEL = LISTING_KIND_LABELS.offsite;

/** kind → bare display label. */
export function listingKindLabel(kind: StoreListingKind): string {
  return LISTING_KIND_LABELS[kind];
}

/** kind → "<label> app" display label. */
export function listingKindAppLabel(kind: StoreListingKind): string {
  return LISTING_KIND_APP_LABELS[kind];
}
