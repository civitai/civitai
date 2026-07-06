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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: url.error, path: ['externalUrl'] });
    }
    const surface = assertNoOnPlatformSurface({
      page: val.page,
      targets: val.targets,
      iframe: val.iframe,
    });
    if (!surface.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: surface.error, path: ['externalUrl'] });
    }
  });

export type SubmitExternalListingInput = z.infer<typeof submitExternalListingSchema>;

/** Withdraw one of the caller's own pending off-site requests (IDOR-checked in the service). */
export const withdrawExternalRequestSchema = z.object({
  publishRequestId: z.string().min(1).max(64),
});
export type WithdrawExternalRequestInput = z.infer<typeof withdrawExternalRequestSchema>;

/** Keyset-paginate the caller's own off-site submissions (my-submissions page, PR-c). */
export const listMySubmissionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
});
export type ListMySubmissionsInput = z.infer<typeof listMySubmissionsSchema>;

/** Keyset-paginate the mod-facing off-site review queue (pending/approved/rejected). */
export const listOffsiteRequestsSchema = listMySubmissionsSchema;
export type ListOffsiteRequestsInput = z.infer<typeof listOffsiteRequestsSchema>;
