import * as z from 'zod';

import {
  MAX_EXTERNAL_URL_LENGTH,
  assertNoOnPlatformSurface,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import {
  OFFSITE_MOD_REASON_MAX,
  OFFSITE_MOD_REASON_MIN,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import {
  ALL_SCOPES,
  SCOPE_JUSTIFICATION_MAX_LENGTH,
} from '~/shared/constants/token-scope.constants';

/**
 * App Store Listings (W13) — P3a OFF-SITE (external-link) submission schemas.
 *
 * The AUTHOR-facing submit surface for a pure external-link off-site app: a
 * native publish-request flow (NOT the retired #2821 mod-only
 * `registerExternalApp` AppBlock path). An app author (the widened
 * `app-blocks-author` cohort — mods + app-dev-testers) submits display metadata
 * + an https target; the service creates a DRAFT `AppListing` + a `pending`
 * `AppListingPublishRequest` (design B1). Mods review + approve/reject in a
 * LATER PR (PR-b). Everything here is DARK behind `app-blocks-author`.
 *
 * URL validation is DELEGATED to the single source of truth in
 * `external-app.schema.ts` (`validateExternalUrl` — https-only, length-bounded)
 * and `assertNoOnPlatformSurface` (external ⟂ on-platform), so the submit schema,
 * the retired-register schema, the service, and the read path can't drift.
 */

/**
 * Off-site listing maturity ratings (author-declared, default `g`). Same domain
 * as `AppBlock.content_rating` / `AppListing.content_rating` (`g`..`x`); an
 * off-site listing has no runtime .red/.com serving gate to mirror, so the author
 * declares it and a mod can adjust at approve (PR-b). The store read path clamps
 * mature (`r`/`x`) rows off a non-red host.
 */
export const OFFSITE_CONTENT_RATINGS = ['g', 'pg', 'pg13', 'r', 'x'] as const;
export type OffsiteContentRating = (typeof OFFSITE_CONTENT_RATINGS)[number];

/** Bounds for the author-supplied display fields (mirror the register/listing shapes). */
export const OFFSITE_NAME_MAX = 120;
export const OFFSITE_TAGLINE_MAX = 140;
export const OFFSITE_DESCRIPTION_MAX = 2000;
export const OFFSITE_CHANGELOG_MAX = 2000;

/** Mod-review note bounds (mirror the on-site approve/reject shapes). */
export const OFFSITE_APPROVAL_NOTES_MAX = 2000;
// Unified with the shared moderator-reason floor (`OFFSITE_MOD_REASON_MIN`, 3)
// so the reject field matches every other mod-reason field on /apps/review and
// the client gate + server schema agree — no divergent magic `10`.
export const OFFSITE_REJECTION_REASON_MIN = OFFSITE_MOD_REASON_MIN;
// Unified with the shared mod-reason CEILING (`OFFSITE_MOD_REASON_MAX`, 1000).
// A reject of a reset-to-pending listing writes a `delist` moderation event
// carrying THIS rejectionReason (offsite-listing.service `rejectExternalRequest` →
// `closeTerminalListing`), so its ceiling must not exceed what a direct mod action
// (`delistListing`, bounded by `OFFSITE_MOD_REASON_MAX`) allows — otherwise a
// rejected-reset could persist a longer reason than the schema permits on the same
// audit surface. (Was 2000; tightened to 1000 for parity.)
export const OFFSITE_REJECTION_REASON_MAX = OFFSITE_MOD_REASON_MAX;

/**
 * Author submit input for an external-app off-site listing (W13 — the MERGED
 * external+connect model). Every external app IS an OAuth app, so this ONE schema
 * carries BOTH the display metadata AND the OAuth-client link:
 *   - `connectClientId`  — REQUIRED: the id of the caller's OWN OAuth client
 *     (ownership, not-app-block, and the scope-ceiling checks are enforced in the
 *     SERVICE, which has the client row; the schema only bounds the shape).
 *   - `requestedScopes`  — a `TokenScope` bitmask the listing DISCLOSES it will
 *     request (review-only; it does NOT gate token issuance — the client's
 *     `allowedScopes` stays the runtime ceiling). The service asserts it is a subset
 *     of the client's ceiling.
 *   - `scopeJustifications` — `{ TokenScope-enum-key: rationale ≤SCOPE_JUSTIFICATION_MAX_LENGTH }`.
 *     Per-value length is bounded here; the key-validity / keys-⊆-requested / non-empty
 *     rules are enforced by the shared `validateConnectScopeJustifications` in the
 *     service (single source with the App Blocks manifest validator).
 *   - `externalUrl`      — OPTIONAL homepage / "Visit ↗" link. Bound loose here
 *     (string length) and validated for the https-only / absolute-URL shape by the
 *     shared `validateExternalUrl` in the superRefine below ONLY WHEN PRESENT (single
 *     source of truth), so a `http:` / `javascript:` / `data:` / over-long URL is
 *     rejected at the schema boundary — while an omitted URL is accepted.
 *
 * `page` / `targets` / `iframe` are accepted as unknown ONLY so the mutual-exclusivity
 * check can REJECT them (an external app must not declare an on-platform surface — see
 * `assertNoOnPlatformSurface`); the service never reads them.
 */
export const submitExternalListingSchema = z
  .object({
    slug: z.string().min(3).max(40).regex(SLUG_REGEX),
    name: z.string().min(1).max(OFFSITE_NAME_MAX),
    // REQUIRED: every external app links its own OAuth client.
    connectClientId: z.string().min(1).max(64),
    // Non-negative bitmask, UPPER-BOUNDED at the full defined scope set (`ALL_SCOPES`,
    // the OR of every TokenScope bit). Without the max, a crafted value beyond int4
    // (e.g. 2**32, or 2**32 + a real bit) survives the subset check — JS bitwise ToInt32
    // in `connectScopesSubsetOfCeiling` truncates it away — then the int4 INSERT raises
    // Postgres 22003, which the service's P2002-only catch surfaces as a raw 500. The
    // `.max` rejects it at the schema boundary (400) instead. `ALL_SCOPES` (not
    // `TokenScope.Full`) is the correct ceiling: Full excludes the AppBlocksSubmit /
    // AppBlocksDevTunnel bits, which a client's `allowedScopes` MAY legitimately carry,
    // so bounding at Full could reject a valid subset. The per-client subset check still
    // lives in the service (it needs the client's `allowedScopes`).
    // OPTIONAL + IGNORED by the service. The listing's requested scopes are
    // AUTO-DERIVED server-side from the client's CURRENT `allowedScopes` at submit
    // time (server-authoritative snapshot — a form-supplied mask is never trusted).
    // Still bounded here (int/nonnegative/≤ALL_SCOPES) so a provided value can't
    // overflow int4, but the stored value comes from the client, not this field.
    requestedScopes: z.number().int().nonnegative().max(ALL_SCOPES).optional(),
    // Per-value length bound only; full key/subset validation is in the service
    // (validated against the DERIVED scope set = the client's allowedScopes).
    scopeJustifications: z.record(z.string(), z.string().max(SCOPE_JUSTIFICATION_MAX_LENGTH)),
    // OPTIONAL homepage / Visit link. Validated for the https-only shape only when present.
    externalUrl: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH).optional(),
    tagline: z.string().max(OFFSITE_TAGLINE_MAX).optional(),
    description: z.string().max(OFFSITE_DESCRIPTION_MAX).optional(),
    // Validated against the shared taxonomy const so adding a category needs no
    // schema change (mirrors the read-path `listAppListingsSchema.category`).
    category: z.enum(MARKETPLACE_CATEGORIES).optional(),
    // Author-declared maturity; defaults to SFW so an omitted rating is never
    // silently treated as mature.
    contentRating: z.enum(OFFSITE_CONTENT_RATINGS).default('g'),
    // Optional "what is this app" changelog note (AppListingPublishRequest.changelog).
    changelog: z.string().max(OFFSITE_CHANGELOG_MAX).optional(),
    // Accepted-but-forbidden on-platform surface fields (rejected below).
    page: z.unknown().optional(),
    targets: z.unknown().optional(),
    iframe: z.unknown().optional(),
  })
  .superRefine((val, ctx) => {
    // externalUrl is OPTIONAL — validate the https shape ONLY when a URL is provided.
    if (val.externalUrl != null) {
      const url = validateExternalUrl(val.externalUrl);
      if (!url.ok) {
        ctx.addIssue({ code: 'custom', message: url.error, path: ['externalUrl'] });
      }
    }
    const surface = assertNoOnPlatformSurface({
      page: val.page,
      targets: val.targets,
      iframe: val.iframe,
    });
    if (!surface.ok) {
      ctx.addIssue({ code: 'custom', message: surface.error, path: ['externalUrl'] });
    }
  });

export type SubmitExternalListingInput = z.infer<typeof submitExternalListingSchema>;

/** Withdraw one of the caller's own pending off-site requests (IDOR-checked in the service). */
export const withdrawExternalRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});
export type WithdrawExternalRequestInput = z.infer<typeof withdrawExternalRequestSchema>;

/**
 * AUTHOR: edit an existing off-site listing WITHOUT withdrawing it (state-aware).
 *
 * `patch` carries ONLY the editable display fields — never `slug` or `kind`
 * (those are immutable for a live listing; a slug change would break its public
 * URL + squat protection). `externalUrl` is bounded loose here and re-validated
 * for the https-only shape by the shared `validateExternalUrl` in the service
 * (single source of truth; this fn is exported + unit-tested directly). Category
 * / contentRating are re-checked against their taxonomies in the service too.
 *
 * At least one field must be present (an empty patch is a no-op the schema
 * rejects, so the client can't accidentally fire a meaningless mutation). The
 * SERVICE routes the patch by the listing's status: draft/pending → in place;
 * approved-trivial → in place; approved-material → staged on a shadow revision.
 */
export const updateListingPatchSchema = z
  .object({
    externalUrl: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH).optional(),
    name: z.string().min(1).max(OFFSITE_NAME_MAX).optional(),
    tagline: z.string().max(OFFSITE_TAGLINE_MAX).nullable().optional(),
    description: z.string().max(OFFSITE_DESCRIPTION_MAX).nullable().optional(),
    category: z.enum(MARKETPLACE_CATEGORIES).nullable().optional(),
    contentRating: z.enum(OFFSITE_CONTENT_RATINGS).optional(),
    // OAuth-connect scope disclosure edit (connect sub-kind only). The two travel
    // as a pair: the SERVICE re-runs the subset-of-ceiling + justification checks
    // (needs the listing's client `allowedScopes`) and rejects justifications
    // without a `requestedScopes` mask, so a scope change re-enters mod review.
    // Upper-bounded at `ALL_SCOPES` for the same int4-overflow reason as the submit
    // schema (a value beyond int4 would 500 on the UPDATE, not 400 at the boundary).
    requestedScopes: z.number().int().nonnegative().max(ALL_SCOPES).optional(),
    scopeJustifications: z
      .record(z.string(), z.string().max(SCOPE_JUSTIFICATION_MAX_LENGTH))
      .optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: 'patch must change at least one field',
  });
export type UpdateListingPatch = z.infer<typeof updateListingPatchSchema>;

export const updateListingSchema = z.object({
  listingId: z.string().min(1).max(64),
  patch: updateListingPatchSchema,
});
export type UpdateListingInput = z.infer<typeof updateListingSchema>;

/**
 * AUTHOR: begin (or re-open) a shadow-draft revision of an APPROVED listing so
 * its MATERIAL fields / assets can be edited while the current version stays
 * live. Idempotent in the service (re-opening returns the existing shadow).
 */
export const beginListingRevisionSchema = z.object({
  listingId: z.string().min(1).max(64),
});
export type BeginListingRevisionInput = z.infer<typeof beginListingRevisionSchema>;

/**
 * AUTHOR: owner-gated prefill read for the dual-mode edit wizard
 * (`/apps/submit?edit=<listingId>`). Returns the listing's scalars + current
 * assets + status + hasPendingRevision (resolving an approved parent's
 * in-progress shadow). The service bounds it to the caller's own listing.
 */
export const getMyListingForEditSchema = z.object({
  listingId: z.string().min(1).max(64),
});
export type GetMyListingForEditInput = z.infer<typeof getMyListingForEditSchema>;

/**
 * AUTHOR: write a scalar patch to an owned DRAFT shadow revision (the approved
 * edit flow's "direct once shadow exists" scalar write). `patch` reuses the same
 * shape/validation as `updateListing` (≥1 field required); the service asserts
 * the target is a draft shadow the caller owns.
 */
export const updateRevisionDraftSchema = z.object({
  shadowId: z.string().min(1).max(64),
  patch: updateListingPatchSchema,
});
export type UpdateRevisionDraftInput = z.infer<typeof updateRevisionDraftSchema>;

/**
 * AUTHOR: submit a prepared shadow-draft revision for mod re-approval. `shadowId`
 * is the id returned by `beginListingRevision` (the hidden draft clone). The
 * optional changelog is denormalized onto the pending publish request.
 */
export const submitListingRevisionSchema = z.object({
  shadowId: z.string().min(1).max(64),
  changelog: z.string().max(OFFSITE_CHANGELOG_MAX).optional(),
});
export type SubmitListingRevisionInput = z.infer<typeof submitListingRevisionSchema>;

/**
 * MOD approve of a pending off-site request (PR-b). Mirrors the on-site
 * `approveRequestSchema` shape: the request id + an optional `approvalNotes`.
 * The asset-completeness gate + the external-URL re-validation are enforced in
 * the SERVICE (not the schema — they read the stored draft listing).
 */
export const approveExternalRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  approvalNotes: z.string().max(OFFSITE_APPROVAL_NOTES_MAX).optional(),
  // Optional mod OVERRIDE of the final content rating stamped on approve. When
  // omitted the service stamps the rating DERIVED from the assets' max detected
  // nsfwLevel; when provided the service FLOORS it at the derived value (never
  // publishes mature assets under a too-low rating). See `approveExternalRequest`.
  contentRating: z.enum(OFFSITE_CONTENT_RATINGS).optional(),
});
export type ApproveExternalRequestInput = z.infer<typeof approveExternalRequestSchema>;

/**
 * MOD reject of a pending off-site request (PR-b). Mirrors the on-site
 * `rejectRequestSchema` shape: the request id + a `rejectionReason` of at least
 * `OFFSITE_REJECTION_REASON_MIN` chars — unified with the shared
 * `OFFSITE_MOD_REASON_MIN` (3) so it matches every other mod-reason field and the
 * client gate. The service re-checks the trimmed length as defense-in-depth,
 * since the service is exported + unit-tested directly.
 */
export const rejectExternalRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
  rejectionReason: z.string().min(OFFSITE_REJECTION_REASON_MIN).max(OFFSITE_REJECTION_REASON_MAX),
});
export type RejectExternalRequestInput = z.infer<typeof rejectExternalRequestSchema>;

/** Keyset-paginate the caller's own off-site submissions (my-submissions page, PR-c). */
export const listMySubmissionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
});
export type ListMySubmissionsInput = z.infer<typeof listMySubmissionsSchema>;

/** Keyset-paginate the mod-facing off-site review queue (pending/approved/rejected). */
export const listOffsiteRequestsSchema = listMySubmissionsSchema;
export type ListOffsiteRequestsInput = z.infer<typeof listOffsiteRequestsSchema>;

/**
 * AUTHOR: persist a Cloudflare-uploaded image into an `Image` row and return its
 * numeric id, so the submit form's asset step can then attach it to the draft
 * listing via the P1 asset-CRUD procs (`setIcon`/`setCover`/`addScreenshot`,
 * which take a numeric `imageId`). The `url` is the CF upload key (a uuid); the
 * width/height/mime/size come from the client media-preprocess pass and are
 * re-validated for the target asset kind by the P1 attach proc — this proc only
 * MATERIALISES the row (and kicks off ingestion/scan). No listing binding here;
 * ownership is bound to the caller (`userId` from ctx), and the attach proc's
 * owner check gates which listing it can be attached to.
 */
export const persistListingAssetImageSchema = z.object({
  // The CF upload key returned by `useCFImageUpload` — imageSchema requires a uuid.
  url: z.string().uuid(),
  name: z.string().max(255).nullish(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.string().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type PersistListingAssetImageInput = z.infer<typeof persistListingAssetImageSchema>;
