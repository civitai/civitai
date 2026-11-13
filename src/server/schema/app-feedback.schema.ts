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

export const APP_FEEDBACK_RECENT_ERRORS_MAX = 10;
export const APP_FEEDBACK_ERROR_MESSAGE_MAX = 300;
/** Bridge message types are SCREAMING_SNAKE; anything else is not one the host sent. */
const BRIDGE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ENUM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** C0/C1 controls and the zero-width and bidi format characters a reader cannot see. */
export const APP_FEEDBACK_UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A UTF-16 surrogate with no partner: Postgres refuses it inside `jsonb`. */
export const APP_FEEDBACK_LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Free text from the reporter's browser, held to what the honest client produces: no control,
 * zero-width or bidi characters (they can make an error line read as something else), and no lone
 * surrogate (it fails the insert, losing the report).
 */
const diagnosticText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !new RegExp(APP_FEEDBACK_UNSAFE_CHARS.source).test(s), 'unsafe characters')
    .refine((s) => !new RegExp(APP_FEEDBACK_LONE_SURROGATE.source).test(s), 'malformed text');

/** `Date`'s own range: past it `toISOString()` throws, and the inbox renders every entry's time. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Why the host did not carry out a request as asked. Bridge drops (`rate_limited`, `deduped`,
 * `no_handler`, `not_applicable`, `validator_rejected`), surface refusals (`review_mode`,
 * `not_ready`, `refused`) and `rewritten`: honoured, but not as the app worded it.
 */
export const APP_FEEDBACK_HOST_REASONS = [
  'rate_limited',
  'deduped',
  'no_handler',
  'not_applicable',
  'validator_rejected',
  'review_mode',
  'not_ready',
  'refused',
  'rewritten',
] as const;
export type AppFeedbackHostReason = (typeof APP_FEEDBACK_HOST_REASONS)[number];

/**
 * One failed reply the host sent the app during this app session: which reply, the platform's
 * error text, and the workflow it concerned. Never a request or response payload. The text is the
 * platform's own error message, so it is shown to the owner as untrusted text, never as markup.
 */
export const appFeedbackRecentErrorSchema = z.object({
  method: z.string().regex(BRIDGE_TYPE),
  message: diagnosticText(APP_FEEDBACK_ERROR_MESSAGE_MAX),
  code: z.string().regex(OPAQUE_ID).max(64).optional(),
  workflowId: z.string().regex(OPAQUE_ID).optional(),
  /**
   * Ids and enum keys from the app's request, never its content: which workflow `kind` / `step`
   * and which checkpoint version it asked for.
   */
  input: z
    .object({
      kind: z.string().regex(ENUM_KEY).optional(),
      step: z.string().regex(ENUM_KEY).optional(),
      modelVersionId: z.number().int().positive().optional(),
    })
    .optional(),
  /** Set when the HOST dropped, refused or rewrote the request rather than a call failing. */
  reason: z.enum(APP_FEEDBACK_HOST_REASONS).optional(),
  /** NAVIGATE only: the scope the app asked for and the one the host resolved it in. */
  scope: z
    .object({
      requested: z.enum(['app', 'site', 'unspecified']),
      resolved: z.enum(['app', 'site']).optional(),
    })
    .optional(),
  /** NAVIGATE only: the app-relative path, without query or fragment. Never a full URL. */
  appRoute: diagnosticText(200).optional(),
  at: z.number().int().nonnegative().max(MAX_EPOCH_MS),
  /** Consecutive identical failures folded into this entry. */
  count: z.number().int().min(1).max(10_000),
});
export type AppFeedbackRecentError = z.infer<typeof appFeedbackRecentErrorSchema>;

export const appFeedbackRecentErrorsSchema = z
  .array(appFeedbackRecentErrorSchema)
  .max(APP_FEEDBACK_RECENT_ERRORS_MAX);

export const APP_FEEDBACK_BROWSER_FAMILIES = [
  'chrome',
  'edge',
  'firefox',
  'safari',
  'opera',
  'samsung',
  'other',
] as const;
export type AppFeedbackBrowserFamily = (typeof APP_FEEDBACK_BROWSER_FAMILIES)[number];
export const APP_FEEDBACK_OS_FAMILIES = [
  'windows',
  'macos',
  'linux',
  'chromeos',
  'android',
  'ios',
  'other',
] as const;
export type AppFeedbackOsFamily = (typeof APP_FEEDBACK_OS_FAMILIES)[number];
/** `classic` scrollbars take layout width (Windows, most Linux); `overlay` ones float over it. */
export const APP_FEEDBACK_SCROLLBAR_KINDS = ['overlay', 'classic'] as const;
export const APP_FEEDBACK_APP_ROUTE_MAX = 200;

const pixels = z.number().int().min(0).max(100_000);

/**
 * Where the report was written: the browser family and major version and the OS family (never the
 * user-agent string), the window size, the scrollbar kind, and the app's own route when the host
 * knows it.
 */
export const appFeedbackEnvironmentSchema = z.object({
  browser: z
    .object({
      family: z.enum(APP_FEEDBACK_BROWSER_FAMILIES),
      major: z.number().int().min(0).max(9999).optional(),
    })
    .optional(),
  os: z.enum(APP_FEEDBACK_OS_FAMILIES).optional(),
  scrollbars: z.enum(APP_FEEDBACK_SCROLLBAR_KINDS).optional(),
  viewport: z.object({ width: pixels, height: pixels }).optional(),
  devicePixelRatio: z.number().min(0.1).max(16).optional(),
  appRoute: diagnosticText(APP_FEEDBACK_APP_ROUTE_MAX).optional(),
});
export type AppFeedbackEnvironment = z.infer<typeof appFeedbackEnvironmentSchema>;

/**
 * The ONLY context an `app-block` row stores. A separate schema from the generic
 * `feedbackContextSchema` on purpose: that one carries host-page diagnostics (console and network
 * errors, the Faro session, screenshots), which describe civitai.com rather than the sandboxed app
 * and are not collected for this area. `recentErrors` is about the APP (failed replies to its own
 * SDK calls) and `environment` about the viewer's browser window, not the page. `z.object` strips
 * every undeclared key, at every level, so a hand-crafted client cannot smuggle anything else in.
 */
export const appFeedbackContextSchema = z.object({
  surface: z.enum(APP_FEEDBACK_SURFACES),
  modelId: z.number().int().positive().optional(),
  recentErrors: appFeedbackRecentErrorsSchema.optional(),
  environment: appFeedbackEnvironmentSchema.optional(),
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

export const hasAnyAppFeedbackForListingSchema = z.object({
  appListingId: z.string().min(1).max(64),
});
export type HasAnyAppFeedbackForListingInput = z.infer<typeof hasAnyAppFeedbackForListingSchema>;

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
  /**
   * `true` = only rows whose listing was deleted (`appListingId` SET NULL by the FK); absent = no
   * filter. Same shape as `flagged`: there is no "listing still exists" filter, so the schema
   * refuses `false` rather than accept a value nothing branches on.
   */
  listingDeleted: z.literal(true).optional(),
  ownerStatus: appFeedbackOwnerStatusFilterSchema.optional(),
  /**
   * `true` = only developer-flagged rows; absent = no filter. There is no "unflagged only" filter:
   * the review tab has no use for one, so the schema refuses `false` rather than accept a value
   * nothing branches on.
   */
  flagged: z.literal(true).optional(),
  hidden: z.enum(APP_FEEDBACK_HIDDEN_FILTERS).default('all'),
});
export type ModListAppFeedbackInput = z.infer<typeof modListAppFeedbackSchema>;

export const modSetAppFeedbackHiddenSchema = z.object({
  id: z.number().int().positive(),
  hidden: z.boolean(),
});
export type ModSetAppFeedbackHiddenInput = z.infer<typeof modSetAppFeedbackHiddenSchema>;
