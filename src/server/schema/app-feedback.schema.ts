import * as z from 'zod';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_OWNER_STATUSES,
} from '~/shared/constants/feedback.constants';

export const APP_FEEDBACK_SURFACES = ['slot', 'page'] as const;
export type AppFeedbackSurface = (typeof APP_FEEDBACK_SURFACES)[number];

/**
 * Which app the feedback is about, as the chrome knows it: the page host has the listing slug,
 * the slot host only the AppBlock id. Never a listing id — the server resolves the listing, so a
 * client cannot aim a report at a shadow revision or at a listing it is not running.
 *
 * Strict objects, so a payload naming both keys is rejected rather than resolved by whichever
 * branch the union happens to try first.
 */
export const appFeedbackTargetSchema = z.union([
  z.strictObject({ slug: z.string().min(1).max(64) }),
  z.strictObject({ appBlockId: z.string().min(1).max(64) }),
]);
export type AppFeedbackTarget = z.infer<typeof appFeedbackTargetSchema>;

/**
 * The ONLY context an `app-block` row stores. A separate schema from the generic
 * `feedbackContextSchema` on purpose: that one carries host-page diagnostics (console and network
 * errors, the Faro session, screenshots), which describe civitai.com rather than the sandboxed app
 * and are not collected for this area. `z.object` strips every undeclared key, so a hand-crafted
 * client cannot smuggle them in.
 */
export const appFeedbackContextSchema = z.object({
  surface: z.enum(APP_FEEDBACK_SURFACES),
  modelId: z.number().int().positive().optional(),
});
export type AppFeedbackContext = z.infer<typeof appFeedbackContextSchema>;

export const getAppFeedbackEligibilitySchema = z.object({ target: appFeedbackTargetSchema });

export const createAppFeedbackSchema = z.object({
  target: appFeedbackTargetSchema,
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  context: appFeedbackContextSchema,
});
export type CreateAppFeedbackInput = z.infer<typeof createAppFeedbackSchema>;

export const feedbackOwnerStatusSchema = z.enum(FEEDBACK_OWNER_STATUSES);

/** `new` is the filter spelling of a NULL `ownerStatus`. */
export const APP_FEEDBACK_OWNER_STATUS_FILTERS = ['new', ...FEEDBACK_OWNER_STATUSES] as const;
export const appFeedbackOwnerStatusFilterSchema = z.enum(APP_FEEDBACK_OWNER_STATUS_FILTERS);
export type AppFeedbackOwnerStatusFilter = z.infer<typeof appFeedbackOwnerStatusFilterSchema>;

export const APP_FEEDBACK_PAGE_LIMIT = 50;

export const listAppFeedbackForListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(APP_FEEDBACK_PAGE_LIMIT),
  ownerStatus: appFeedbackOwnerStatusFilterSchema.optional(),
});
export type ListAppFeedbackForListingInput = z.infer<typeof listAppFeedbackForListingSchema>;

export const setAppFeedbackOwnerStatusSchema = z.object({
  id: z.number().int().positive(),
  appListingId: z.string().min(1).max(64),
  ownerStatus: feedbackOwnerStatusSchema,
  /** What the caller last saw; `null` = new. The write is refused if the row moved since. */
  expectedOwnerStatus: feedbackOwnerStatusSchema.nullable(),
});
export type SetAppFeedbackOwnerStatusInput = z.infer<typeof setAppFeedbackOwnerStatusSchema>;

export const flagAppFeedbackSchema = z.object({
  id: z.number().int().positive(),
  appListingId: z.string().min(1).max(64),
});
export type FlagAppFeedbackInput = z.infer<typeof flagAppFeedbackSchema>;

export const APP_FEEDBACK_HIDDEN_FILTERS = ['hidden', 'visible', 'all'] as const;

export const modListAppFeedbackSchema = z.object({
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(APP_FEEDBACK_PAGE_LIMIT),
  appListingId: z.string().min(1).max(64).optional(),
  /** Rows whose listing was deleted (`appListingId` SET NULL by the FK). */
  listingDeleted: z.boolean().optional(),
  ownerStatus: appFeedbackOwnerStatusFilterSchema.optional(),
  flagged: z.boolean().optional(),
  hidden: z.enum(APP_FEEDBACK_HIDDEN_FILTERS).default('all'),
});
export type ModListAppFeedbackInput = z.infer<typeof modListAppFeedbackSchema>;

export const modSetAppFeedbackHiddenSchema = z.object({
  id: z.number().int().positive(),
  hidden: z.boolean(),
});
export type ModSetAppFeedbackHiddenInput = z.infer<typeof modSetAppFeedbackHiddenSchema>;
