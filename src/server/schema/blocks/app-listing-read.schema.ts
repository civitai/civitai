import * as z from 'zod';

import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';

/**
 * App Store Listings (W13) — P2a UNIFIED STORE READ PATH schemas + public DTOs.
 *
 * These back the NEW `appListings.listAvailable` / `appListings.getAppDetail`
 * read procs that serve the unified `/apps` store over BOTH kinds (`onsite`
 * AppBlocks + `offsite` external/connect apps) from the durable `AppListing`
 * record. They MIRROR the existing AppBlock read path
 * (`blocks.listAvailable` / `blocks.getAppDetail` +
 * `subscription.schema.ts::AvailableBlock` / `PublicAppDetail`) so the two can't
 * drift, but read `AppListing` rather than `AppBlock`.
 *
 * DARK / parallel-run: nothing here is on the LIVE `/apps` surface yet (that
 * still reads the AppBlock path). The new procs live ALONGSIDE it behind the
 * SAME mod-segmented App Blocks flag; the UI switch + cutover are later PRs.
 *
 * SECURITY: every DTO below is a PUBLIC-FIELD ALLOWLIST (like `AvailableBlock` /
 * `PublicBlockManifest`). Internal fields (trustTier, raw iframe.src, OAuth
 * secrets, owner PII beyond the public creator chip, DB status) are NEVER shaped
 * in — a field can only leak if it is added here on purpose.
 */

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

/** Kind filter for the unified store: everything, on-site only, or off-site only. */
export const listingKindFilterSchema = z.enum(['all', 'onsite', 'offsite']);
export type ListingKindFilter = z.infer<typeof listingKindFilterSchema>;

/**
 * Store sort options:
 *   - `top-rated` (DEFAULT) — Bayesian-shrinkage on the recommend proportion
 *     (up / (up+down)) DESC; a few-review 100%-recommend app can't outrank a
 *     many-review 90% app, and 0-review apps sit mid-pack at the global mean
 *     recommend rate (mirrors the AppBlock `rating` sort, on a proportion
 *     instead of a 1..5 average). Ties fall back to install_count then id.
 *   - `popular`  — install_count DESC (from the AppListingMetric rollup).
 *   - `newest`   — created_at DESC.
 *   - `name`     — name ASC (case-insensitive).
 */
export const listingSortSchema = z.enum(['top-rated', 'popular', 'newest', 'name']);
export type ListingSort = z.infer<typeof listingSortSchema>;

export const listAppListingsSchema = z.object({
  kind: listingKindFilterSchema.default('all'),
  // Category filter validated against the single-source taxonomy const (shared
  // with the AppBlock path) so adding a category needs no schema migration.
  category: z.enum(MARKETPLACE_CATEGORIES).optional(),
  sort: listingSortSchema.default('top-rated'),
  // Opaque keyset cursor (base64url) — see app-listing.service encode/decode.
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ListAppListingsInput = z.infer<typeof listAppListingsSchema>;

/**
 * REST-query variant of {@link listAppListingsSchema} for the public
 * `GET /api/v1/apps` endpoint. Identical filter axes + bounds, but `limit`
 * arrives as a STRING query param, so it is coerced (empty/absent → the default)
 * and the parse output is exactly a {@link ListAppListingsInput} — the same
 * object the listing service consumes. A factory (not a const) so the endpoint
 * gets a fresh schema without pulling the whole read-schema module's eval graph
 * at import time. NOTE: the store service supports no free-text search or slot
 * filter, so neither is accepted here (they would be inert).
 */
export function getAppListingsListQuery() {
  return z.object({
    kind: listingKindFilterSchema.default('all'),
    category: z.enum(MARKETPLACE_CATEGORIES).optional(),
    sort: listingSortSchema.default('top-rated'),
    cursor: z.string().max(128).optional(),
    limit: z
      .preprocess(
        (v) => (v === undefined || v === null || v === '' ? undefined : Number(v)),
        z.number().int().min(1).max(50)
      )
      .default(20),
  });
}

/**
 * W13 POST-APPROVAL MOD MANAGEMENT — the moderator all-status listings read.
 *
 * Backs `appListings.listAllListingsForModeration` (moderatorProcedure): unlike
 * the public `listAvailable` (approved-only, public allowlist), this returns
 * listings across EVERY lifecycle status for the mod management table. All filters
 * are optional (omitted = the whole store); `search` matches name OR slug
 * server-side (case-insensitive). Keyset-paginated by the ULID `id` (a stable
 * total order), bounded `limit` ≤ 50 (mirrors `listListingReportsSchema`).
 */
export const listAllListingsForModerationSchema = z.object({
  // Full AppListing lifecycle set (draft|pending|approved|rejected|removed).
  status: z.enum(APP_LISTING_STATUSES).optional(),
  kind: z.enum(['onsite', 'offsite']).optional(),
  // Server-side name/slug substring filter (bounded; trimmed in the service).
  search: z.string().max(200).optional(),
  // Opaque keyset cursor = the last row's `id` (bounded, same as the sibling
  // mod-read queues). A tampered value just yields a different/empty page.
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export type ListAllListingsForModerationInput = z.infer<
  typeof listAllListingsForModerationSchema
>;

/** Detail lookup by EXACTLY ONE of slug or id (approved listings only). */
export const getAppListingDetailSchema = z
  .object({
    slug: z.string().min(1).max(64).optional(),
    id: z.string().min(1).max(64).optional(),
  })
  .refine((d) => (d.slug ? 1 : 0) + (d.id ? 1 : 0) === 1, {
    message: 'Provide exactly one of `slug` or `id`',
  });
export type GetAppListingDetailInput = z.infer<typeof getAppListingDetailSchema>;

// ---------------------------------------------------------------------------
// Public DTOs (allowlist projections).
// ---------------------------------------------------------------------------

export type ListingKind = 'onsite' | 'offsite';

/**
 * Public creator chip — id/username/image ONLY (the standard public-user
 * projection subset). No email/PII. `null` only if the owner row vanished.
 */
export type ListingCreatorChip = {
  id: number;
  username: string | null;
  image: string | null;
};

/**
 * Recommend rollup, read from the `AppListingMetric` rollup (P5-populated).
 * `recommendPct` is `null` when there are no reviews yet (metric row absent OR
 * zero counts) so the UI can render "no reviews yet" instead of "0%".
 */
export type ListingRecommendRollup = {
  recommendedCount: number;
  notRecommendedCount: number;
  /** up / (up+down) in [0,1], or null when there are no reviews yet. */
  recommendPct: number | null;
};

/** Kind-specific card fields (discriminated by the card's `kind`). */
export type ListingCardKindData =
  | {
      kind: 'onsite';
      /** Backing AppBlock id (the runtime), or null for a native off-site row. */
      appBlockId: string | null;
      /** True when the app declares a launch page (Open CTA) vs a model-slot install (Install CTA). */
      hasPage: boolean;
      /**
       * Already-public standalone block origin (no token/scope) — IDENTICAL in
       * name + type to the detail projection's `liveUrl`, so a client can link an
       * onsite app straight from the list card without an N+1 detail fetch. An
       * onsite card only appears once its backing block has deployed (the same
       * deploy-gate the detail read applies), so this origin is always live.
       */
      liveUrl: string;
    }
  | {
      kind: 'offsite';
      /**
       * External destination (Visit CTA), https-guarded; null when the listing
       * has none. 🔴 This is the ONLY off-site field on a card — the card DTO
       * deliberately carries no `connectClientId`, so nothing downstream of it
       * can re-derive a sub-kind.
       */
      externalUrl: string | null;
    };

/** One store card over EITHER kind (the unified `/apps` grid). */
export type ListingCard = {
  id: string;
  slug: string;
  kind: ListingKind;
  name: string;
  tagline: string | null;
  category: string | null;
  contentRating: string | null;
  iconUrl: string | null;
  /** Cover image, or the first screenshot as a fallback, or null. */
  coverUrl: string | null;
  creator: ListingCreatorChip | null;
  recommend: ListingRecommendRollup;
  /** Total reviews reflected in the recommend rollup (recommended + not). */
  reviewCount: number;
  /**
   * AUTHOR-DECLARED "this app is in beta" flag — renders a small badge on the card.
   *
   * 🔴 ALLOWLIST JUSTIFICATION. A boolean the author chose to publish about their own app,
   * carrying no information about anyone else and gating nothing. It affects no ranking,
   * no curation and no CTA — it is a label.
   *
   * 🔴 THE FLAG IS ON THE CARD, THE MESSAGE IS NOT, and the asymmetry is the same one
   * `sourceRepoUrl` makes for the opposite reason. A grid of store cards is a
   * low-attention surface with no room for a sentence; the badge is the whole signal a
   * card can carry honestly. `betaMessage` appears on the DETAIL page, where there is
   * room to read it. The exact-key-set assertions in `app-listing.service.test.ts` pin
   * both halves.
   *
   * `false` while the MANUAL-APPLY migration is outstanding — see `projectListingCard`.
   */
  isBeta: boolean;
  /**
   * Play count from the `AppListingMetric` rollup (`open_count`) — how many times
   * the app was OPENED — or `null` when the number is structurally unmeasurable.
   *
   * 🔴 ALLOWLIST JUSTIFICATION. The exact same argument as `ListingDetail.installCount`,
   * one step weaker and still sufficient: an aggregate over the whole audience that
   * identifies no user, reveals nothing about WHO opened the app or WHEN, and gates
   * nothing. It is the store analogue of the public play/view counts every other
   * content type on the platform already renders. Unlike `installCount` it is not yet
   * derivable from a public sort, so this does surface a new (aggregate) fact — which
   * is the intent: a store card should be able to say how used an app is.
   *
   * 🔴 `null` IS NOT `0`, AND THE DIFFERENCE IS A TRUTH CLAIM RATHER THAN A STYLE ONE.
   * An OFF-SITE listing's CTA is a plain `target="_blank"` anchor to a third party, so
   * no on-platform request follows the click and there is nothing trustworthy to count.
   * Its play count is ABSENT, not zero — the renderer omits the stat row entirely for
   * `null`, whereas a `0` would render as "nobody has ever used this app", a false
   * statement about an app we simply cannot measure. `app_listing_metrics.open_count`
   * is `Int NOT NULL DEFAULT 0`, so an off-site row DOES carry a literal `0` in the
   * column; `projectListingCard` discriminates on `kind` precisely so that column value
   * never reaches this field.
   *
   * 🔴 The mirror is equally load-bearing: an ON-SITE listing nobody has opened yet is a
   * genuine `0` and must stay `0`. A missing metric row means "no plays recorded yet",
   * which is 0 — the same COALESCE-to-0 reading `installCount` documents.
   *
   * Reads `0` for every on-site listing until the rollup that populates `open_count`
   * ships and the events feeding it exist.
   */
  openCount: number | null;
  kindData: ListingCardKindData;
};

export type ListingGalleryScreenshot = {
  url: string;
  caption: string | null;
};

/** Kind-specific action data on the detail page. */
export type ListingDetailKindData =
  | {
      kind: 'onsite';
      appBlockId: string | null;
      hasPage: boolean;
      /** Already-public standalone block origin (no token/scope). */
      liveUrl: string;
    }
  | {
      kind: 'offsite';
      externalUrl: string | null;
      /**
       * Public OAuth client_id (NOT a secret) when this listing has an OAuth app
       * connected; null otherwise.
       *
       * 🔴 This is a CAPABILITY flag, not a kind discriminator. Off-site listings
       * used to fork into a `connect` / `external-link` sub-kind derived from
       * exactly this field, and the store rendered two different KIND labels off
       * it. That fork is gone — every off-site listing is one thing. What survives
       * is the capability question "does this app connect to your Civitai
       * account?", which two surfaces legitimately still ask (the account-access
       * disclosure in `AppListingDetailBody` and the no-destination fallback in
       * `getDetailPrimaryAction`). Read it for THAT; never to re-derive a kind.
       */
      connectClientId: string | null;
    };

/** Full public detail for one approved listing (card fields + gallery + body). */
export type ListingDetail = {
  id: string;
  /**
   * Integer surrogate key (`app_listings.serial_id`). Carried so the detail page
   * can mount the CommentsV2 discussion (`<CommentsProvider entityType="appListing"
   * entityId={serialId} />`) — CommentsV2 is integer-keyed, the store `id` is a TEXT
   * ULID. Public + non-sensitive (an opaque row number, like the numeric ids already
   * exposed for images/models/posts).
   */
  serialId: number;
  slug: string;
  kind: ListingKind;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  contentRating: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  creator: ListingCreatorChip | null;
  /**
   * PUBLIC BYLINE — the app's ACCEPTED collaborators who have opted IN to display
   * (`AppCollaborator.status = 'accepted' AND displayed = true`). Same
   * `{id, username, image}` allowlist as `creator`.
   *
   * 🔴 A PENDING OR REJECTED INVITE MUST NEVER APPEAR HERE. Otherwise an owner could
   * attach any stranger's name and avatar to their listing just by inviting them.
   * Empty for a listing with no backing AppBlock, and empty until the manual-apply
   * collaborator migration lands.
   */
  collaborators: ListingCreatorChip[];
  recommend: ListingRecommendRollup;
  reviewCount: number;
  /**
   * Last time the listing row itself changed (`app_listings.updated_at`), as an ISO-8601
   * string.
   *
   * 🔴 ALLOWLIST JUSTIFICATION. Non-sensitive, and the direct analogue of the model
   * detail page's `Updated: <date>` meta line (`Model.updatedAt`, rendered publicly for
   * every model). It reveals only that an approved, publicly-listed app was edited — the
   * same fact the store's `newest` sort already exposes for `created_at`. It carries no
   * information about WHO edited it or WHAT changed.
   *
   * A STRING, not a `Date`: this DTO is also served by the public REST
   * `GET /api/v1/apps/...` path, which has no tRPC transformer, so a JSON-safe scalar is
   * the only shape both transports agree on.
   */
  updatedAt: string;
  /**
   * Install count from the `AppListingMetric` rollup (`install_count`).
   *
   * 🔴 ALLOWLIST JUSTIFICATION. Already publicly OBSERVABLE, not merely public: the
   * store's `popular` sort is `install_count DESC` (see `listAppListingsSchema`), so the
   * full ordering of every approved listing by this number is already derivable from the
   * public list endpoint. Surfacing the number itself adds precision, not a new fact. It
   * is an aggregate over the whole install base — it identifies no user. Direct analogue
   * of the model page's public download-count stat chip.
   *
   * `0` when the metric row is absent (a listing nobody has installed yet), matching how
   * the ranking SQL reads it (`COALESCE(m.install_count, 0)`).
   */
  installCount: number;
  /**
   * PUBLIC SOURCE-REPOSITORY link ("this app is open source"), or null.
   *
   * 🔴 ALLOWLIST JUSTIFICATION. It is a link the AUTHOR chose to publish about their
   * own app, host-restricted to github.com / gitlab.com / codeberg.org and normalised
   * to `https://<host>/<owner>/<repo>` by `validateRepositoryUrl` — so it can carry no
   * credentials, no port, no query string, no deep path and no host outside that set.
   * It reveals nothing the author has not deliberately made public, and it is
   * moderator-gated on both kinds (manifest-governed + re-reviewed on approve for
   * on-site; a MATERIAL patch field routing through a shadow revision for off-site).
   *
   * 🔴 DETAIL-ONLY, and the asymmetry with `tagline`/`category` is deliberate: it is
   * NOT on `ListingCard`. A grid of store cards is a low-attention surface where an
   * outbound link has no room for the context that makes it safe to click; the detail
   * page shows it as one labelled row next to the app's other declared facts. Adding it
   * to the card DTO would put an un-contextualised outbound link on every `/apps` tile.
   * The exact-key-set assertions in `app-listing.service.test.ts` pin both halves.
   *
   * 🔴 NOT `AppBlock.repoUrl` — that is the app's INTERNAL Forgejo repository and is
   * never public. This is a separate, author-declared column (`source_repo_url`).
   *
   * A STRING (or null), not an object: this DTO also crosses the transformer-less
   * public REST `GET /api/v1/apps/{slug}` boundary, so it must be a JSON-safe scalar.
   * Null while the MANUAL-APPLY migration is outstanding — see `projectListingDetail`.
   */
  sourceRepoUrl: string | null;
  /**
   * AUTHOR-DECLARED "this app is in beta" flag. Same allowlist justification as
   * `ListingCard.isBeta` — a label the author publishes about their own app.
   *
   * `false` while the MANUAL-APPLY migration is outstanding — see `projectListingDetail`.
   */
  isBeta: boolean;
  /**
   * The author's optional short beta note (≤`BETA_MESSAGE_MAX`), or null.
   *
   * 🔴 PLAIN TEXT, NOT MARKDOWN, AND THAT IS A SECURITY DECISION RATHER THAN A STYLE ONE.
   * `description` on this same DTO renders through `AppListingDescription` →
   * `CustomMarkdown`; this deliberately does not, so the string cannot mint a link, an
   * image or any element at all. It is rendered as a text node. Do NOT route it through
   * `CustomMarkdown`, and never through `dangerouslySetInnerHTML`.
   *
   * 🔴 THE TRUST POSTURE IS THE SAME ONE `description` ALREADY HAS on this surface —
   * author-controlled public copy that no moderator reviews before it goes live, because
   * beta is a TRIVIAL patch field. The mitigations are deterministic rather than
   * procedural: a bounded length enforced in zod at the request boundary, and plain-text
   * rendering. The residual risk is the same as `description`'s: an author can write
   * misleading prose about their own app, which is a moderation problem (the listing is
   * delistable) and not a rendering one.
   *
   * A STRING (or null), not an object: this DTO also crosses the transformer-less public
   * REST `GET /api/v1/apps/{slug}` boundary, so it must be a JSON-safe scalar. Null while
   * the MANUAL-APPLY migration is outstanding.
   */
  betaMessage: string | null;
  /** Ordered gallery — screenshots whose backing Image still exists (null-image rows dropped). */
  screenshots: ListingGalleryScreenshot[];
  kindData: ListingDetailKindData;
};
