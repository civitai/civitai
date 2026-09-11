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

/**
 * 🔒 THE SINGLE SOURCE for the name of the KIND FACET ITSELF — the word a viewer
 * reads above the thing, as opposed to the words for its values above.
 *
 * The store's filter panel called this facet **"Type"** while the listing detail
 * page's Details rail called the same field **"Kind"**. One field, two words, on two
 * surfaces a viewer moves between in a single session — the identical N-sites defect
 * this module was created for, one level up: the VALUE labels were unified here and
 * the FACET label was left open-coded at each site.
 *
 * Reported by a tester on 2026-09-10: *"why is it 'Kind' and not 'Type'? Should be
 * 'Type', just like in the filter."*
 *
 * 🔴 "Type" WON because the filter is where a viewer meets the concept FIRST and it
 * is the more common word; the detail row was the outlier. As with the labels above,
 * this is a DISPLAY name only — the stored value, the `kind` query param, the
 * `StoreListingKind` union and the public `/api/v1/apps` enum are untouched.
 */
export const LISTING_FACET_LABELS = {
  kind: 'Type',
} as const satisfies Record<string, string>;

/**
 * 🔴 A MAP, NOT A SCALAR, AND THE SHAPE IS LOAD-BEARING TWICE OVER.
 *
 * 1. `listingLabelCallSites.test.ts`'s `bare-option-label` rule requires that a
 *    `label:` paired with a `value:` in the same object literal be "a LOOKUP or a
 *    LITERAL, never a bare identifier". A detail ROW literal is `{key, label, value}`,
 *    which matches that shape even though it is not a Select option — so a scalar
 *    constant here trips a guard aimed at `{value: r, label: r}`. `LISTING_FACET_LABELS.kind`
 *    is a lookup and satisfies the rule as written. **Conform to the guard; do not
 *    widen it for this.** It was narrowed deliberately and its own tests say so.
 * 2. ⚠ A `category` key was TRIED and BACKED OUT — recorded so nobody adds it again.
 *    The reasoning was sound (category is the other facet named on both surfaces, so
 *    it is the next one that can drift), but `LISTING_FACET_LABELS.category` in a
 *    `label:` position trips `listingLabelCallSites.test.ts`'s OTHER rule, which
 *    name-matches a `.category` read rendered as a label — the rule that exists
 *    because these rows once shipped the raw stored enum. That guard is RIGHT to be
 *    suspicious of that shape, and the two surfaces agree on "Category" today, so
 *    this was a speculative fix colliding with a real one. If category ever does
 *    drift, fix it in a way the guard can tell apart from the defect it hunts.
 */
export const LISTING_KIND_FACET_LABEL = LISTING_FACET_LABELS.kind;

/**
 * 🔒 THE SINGLE SOURCE for the listing detail page's REVIEWS section anchor.
 *
 * The Details rail's "Reviews" row links here; the section itself carries this as its
 * `id`. Both sides must read this constant, because the failure mode is SILENT: an
 * `href="#…"` pointing at an id nothing renders does nothing at all — no error, no
 * console warning, just a link that appears to be broken to the one person who tried
 * it. A tester reported the rail's Reviews line as "not clickable"; a link that
 * scrolls nowhere is the same experience with more steps.
 *
 * Lives here rather than in the component so the two sites cannot be edited apart, in
 * the same spirit as the kind labels above.
 */
export const LISTING_REVIEWS_ANCHOR_ID = 'app-listing-reviews';

/** kind → bare display label. */
export function listingKindLabel(kind: StoreListingKind): string {
  return LISTING_KIND_LABELS[kind];
}

/** kind → "<label> app" display label. */
export function listingKindAppLabel(kind: StoreListingKind): string {
  return LISTING_KIND_APP_LABELS[kind];
}
