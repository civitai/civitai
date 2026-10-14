import * as z from 'zod';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  PLATFORM_FEEDBACK_DOC_URL_PREFIX,
} from '~/shared/constants/feedback.constants';

export const PLATFORM_FEEDBACK_ABOUT = [
  'cli',
  'sdk',
  'docs',
  'review',
  'sandbox',
  'scopes',
  'mcp',
  'other',
] as const;
export const PLATFORM_FEEDBACK_KINDS = ['bug', 'confusing', 'missing', 'request'] as const;
export const PLATFORM_FEEDBACK_CLIENTS = ['civitai-cli', 'civitai-mcp', 'other'] as const;
export type PlatformFeedbackClient = (typeof PLATFORM_FEEDBACK_CLIENTS)[number];

export { PLATFORM_FEEDBACK_DOC_URL_PREFIX };
export const PLATFORM_FEEDBACK_REFS_MAX = 50;

const version = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[0-9A-Za-z.+-]+$/);

export const PLATFORM_FEEDBACK_UNSTORABLE_TEXT = 'Contains a character that cannot be stored.';

// A NUL or an unpaired surrogate. Postgres accepts neither in `text` or `jsonb`, so one in a
// captured error excerpt would otherwise fail the write as a 500.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !UNSTORABLE.test(value), PLATFORM_FEEDBACK_UNSTORABLE_TEXT);

/**
 * The only part of a stored `apps-platform` context that comes from the client. `z.object` strips
 * undeclared keys at every level, so a client cannot write the server-owned half of the context
 * (`server`: the fingerprint, the counters, a moderator's resolution) by sending one.
 *
 * Every bound rejects rather than clips: the sender is a program, and a clipped value would be
 * stored as though it were what the program sent.
 */
export const platformFeedbackReportSchema = z.object({
  about: z.enum(PLATFORM_FEEDBACK_ABOUT),
  kind: z.enum(PLATFORM_FEEDBACK_KINDS).default('bug'),
  /** A client-authored key for the failure site, e.g. `submit.server-refused`. Reports sharing one are counted together. */
  ref: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)
    .optional(),
  client: z.object({ name: z.enum(PLATFORM_FEEDBACK_CLIENTS), version }),
  agent: text(40).optional(),
  os: text(16).optional(),
  arch: text(16).optional(),
  command: text(120).optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  sdk: z
    .array(z.object({ name: text(40), version: text(32) }))
    .max(4)
    .optional(),
  docUrl: text(300).startsWith(PLATFORM_FEEDBACK_DOC_URL_PREFIX).optional(),
  errorExcerpt: text(500).optional(),
  appSlug: text(64).optional(),
});
export type PlatformFeedbackReport = z.infer<typeof platformFeedbackReportSchema>;

export const createPlatformFeedbackSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(FEEDBACK_MESSAGE_MAX_LENGTH)
    .refine((value) => !UNSTORABLE.test(value), PLATFORM_FEEDBACK_UNSTORABLE_TEXT),
  report: platformFeedbackReportSchema,
});
export type CreatePlatformFeedbackInput = z.infer<typeof createPlatformFeedbackSchema>;

/**
 * A ref's shape is deliberately not validated here: malformed, unknown and wrong-suffix refs all
 * answer `found: false`, so the response does not say which. The length bound only caps the input.
 */
export const getPlatformFeedbackStatusSchema = z.object({
  refs: z.array(z.string().max(80)).min(1).max(PLATFORM_FEEDBACK_REFS_MAX),
});
export type GetPlatformFeedbackStatusInput = z.infer<typeof getPlatformFeedbackStatusSchema>;

export const PLATFORM_FEEDBACK_READBACK_STATUSES = [
  'received',
  'acknowledged',
  'fixed',
  'addressed',
  'not_planned',
] as const;
export type PlatformFeedbackReadbackStatus = (typeof PLATFORM_FEEDBACK_READBACK_STATUSES)[number];

const fixedInSchema = z.object({ component: z.string(), version: z.string() });

/**
 * `context.server` as read back from the column. It is written by this service and, for
 * `resolution`, by the moderator app, so it is parsed rather than trusted: a field that does not
 * fit reads as absent instead of failing the request.
 */
export const platformFeedbackServerStateSchema = z.object({
  fingerprint: z.string().catch(''),
  reporters: z.number().int().catch(1),
  reports: z.number().int().catch(1),
  firstSeenAt: z.string().nullable().catch(null),
  lastSeenAt: z.string().nullable().catch(null),
  regressionOf: z.number().int().optional().catch(undefined),
  reopenOf: z.number().int().optional().catch(undefined),
  resolution: z
    .object({
      fixedIn: fixedInSchema.optional().catch(undefined),
      publicNote: z.string().optional().catch(undefined),
      at: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type PlatformFeedbackServerState = z.infer<typeof platformFeedbackServerStateSchema>;
