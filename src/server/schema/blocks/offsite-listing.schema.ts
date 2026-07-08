import * as z from 'zod';

import {
  MAX_EXTERNAL_URL_LENGTH,
  assertNoOnPlatformSurface,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';

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
export const OFFSITE_REJECTION_REASON_MIN = 10;
export const OFFSITE_REJECTION_REASON_MAX = 2000;

/**
 * Author submit input for a pure external-link off-site listing.
 *
 * `externalUrl` is bound loose here (string length) and validated for the
 * https-only / absolute-URL shape by the shared `validateExternalUrl` in the
 * superRefine below (single source of truth), so a `http:` / `javascript:` /
 * `data:` / over-long URL is rejected at the schema boundary — not just in the
 * service. `page` / `targets` / `iframe` are accepted as unknown ONLY so the
 * mutual-exclusivity check can REJECT them (an external app must not declare an
 * on-platform surface — see `assertNoOnPlatformSurface`); the service never reads
 * them.
 */
export const submitExternalListingSchema = z
  .object({
    slug: z.string().min(3).max(40).regex(SLUG_REGEX),
    name: z.string().min(1).max(OFFSITE_NAME_MAX),
    externalUrl: z.string().min(1).max(MAX_EXTERNAL_URL_LENGTH),
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
    const url = validateExternalUrl(val.externalUrl);
    if (!url.ok) {
      ctx.addIssue({ code: 'custom', message: url.error, path: ['externalUrl'] });
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
});
export type ApproveExternalRequestInput = z.infer<typeof approveExternalRequestSchema>;

/**
 * MOD reject of a pending off-site request (PR-b). Mirrors the on-site
 * `rejectRequestSchema` shape: the request id + a `rejectionReason` of at least
 * 10 chars (the service re-checks the trimmed length as defense-in-depth, since
 * the service is exported + unit-tested directly).
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
