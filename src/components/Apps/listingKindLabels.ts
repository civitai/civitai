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
 * ## 🔴 "On-site" → "Embedded": THE DEFERRAL WAS LIFTED, DELIBERATELY
 *
 * This module used to record that renaming "On-site" → "Embedded" had been DEFERRED,
 * because "Embedded" reads close to "Embedding" (TextualInversion) — a model-type
 * option one panel away in `AppSettingsModal.tsx`. **That deferral is reversed by an
 * explicit product decision.** The kinds are now **Embedded** (runs inside Civitai)
 * and **Standalone** (hosted elsewhere), which say what the kinds ARE; "On-site" said
 * only where they were not.
 *
 * 🔴 THE COLLISION SURVIVES THE DECISION — it was not disproved, it was accepted, so
 * the mitigation is written down rather than left to memory:
 *
 *   - The model-type label **`'Embedding'` is NOT renamed.** It names a
 *     `ModelType.TextualInversion`, a completely different concept with its own
 *     public vocabulary; renaming it to dodge a UI adjacency would be the copy
 *     change breaking the larger contract.
 *   - **Where a kind label can render in the same view as a model-type list, prefer
 *     the `LISTING_KIND_APP_LABELS` form** (`'Embedded app'`). The noun is the
 *     disambiguator: "Embedded app" cannot be read as a model type, while a bare
 *     "Embedded" beside "Embedding" can. `AppSettingsModal` is the measured instance
 *     (its `MODEL_TYPE_OPTIONS` carries `'Embedding'`), and it renders no kind label
 *     today — so this is the rule for the next surface, not a repair of an existing one.
 *
 * `standaloneWordingCallSites.test.ts` pins the new labels literally and pins that the
 * lift was a decision (it asserts the labels DO carry the new word, where it used to
 * assert they did not).
 */

/** kind → the bare noun a human reads. */
export const LISTING_KIND_LABELS: Record<StoreListingKind, string> = {
  onsite: 'Embedded',
  offsite: 'Standalone',
};

/** kind → the label as a full noun phrase ("… app"), for table cells and badges. */
export const LISTING_KIND_APP_LABELS: Record<StoreListingKind, string> = {
  onsite: 'Embedded app',
  offsite: 'Standalone app',
};

/**
 * The offsite label on its own. Exported so prose that names the kind in a sentence
 * ("List a Standalone app hosted elsewhere") composes from the same constant the
 * badge uses, instead of re-typing the word.
 */
export const STANDALONE_KIND_LABEL = LISTING_KIND_LABELS.offsite;

/**
 * The onsite label on its own — the mirror of {@link STANDALONE_KIND_LABEL}, and it
 * exists for the same reason: prose that names the kind in a sentence ("Embedded and
 * Standalone apps") composes from the same constant the badge uses instead of
 * re-typing the word. Before this existed, every prose site that named the on-site
 * kind hardcoded it, which is how `/apps/mine` and `/apps/review` ended up spelling it
 * two different ways.
 */
export const EMBEDDED_KIND_LABEL = LISTING_KIND_LABELS.onsite;

/** kind → bare display label. */
export function listingKindLabel(kind: StoreListingKind): string {
  return LISTING_KIND_LABELS[kind];
}

/** kind → "<label> app" display label. */
export function listingKindAppLabel(kind: StoreListingKind): string {
  return LISTING_KIND_APP_LABELS[kind];
}
