import * as z from 'zod';
import {
  FEEDBACK_AREAS,
  FEEDBACK_FILTER_VALUE_MAX_LENGTH,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_PATH_MAX_LENGTH,
  FEEDBACK_SESSION_ID_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';

export const feedbackAreaSchema = z.enum(FEEDBACK_AREAS);

// Everything here is client-supplied and therefore a claim, not evidence — the
// submit request cannot re-derive which backend served the page the user was
// looking at. Stored to make a one-line report actionable, never read as proof.
//
// The same reading applies to the three fields added for images / session / DOM
// capture. `images` and `screenshotId` are ids the CLIENT says it uploaded: this
// request never proves the objects exist, that they belong to this user, or that
// the screenshot is of the page named in `path`. `sessionId` is whatever the
// browser's Faro instance reported, and is absent whenever Faro is not running
// (dev, test, preview, an ad-blocked or opted-out session) — absence is the
// ordinary case, not an error. Every one of them is bounded because a JSONB
// column will store exactly what it is handed.
const feedbackContextSchema = z.object({
  path: z.string().max(FEEDBACK_PATH_MAX_LENGTH).optional(),
  reportedSource: z.string().max(50).optional(),
  reportedPageSources: z.array(z.string().max(50)).max(500).optional(),
  pagesLoaded: z.number().int().min(0).max(10_000).optional(),
  // The value bound is now the exported `FEEDBACK_FILTER_VALUE_MAX_LENGTH` rather than
  // an inline literal: `/apps` reports its URL-backed free-text search term here, so a
  // caller has to clip to this number and the two must not be able to drift. Same
  // value (200), no widening — a `max()` REJECTS rather than truncates, so clipping is
  // the caller's job either way.
  filters: z
    .record(
      z.string().max(50),
      z.union([z.string().max(FEEDBACK_FILTER_VALUE_MAX_LENGTH), z.number(), z.boolean()])
    )
    .refine((val) => Object.keys(val).length <= 20, 'Too many filter keys')
    .optional(),
  /**
   * Image ids for files the user attached by hand.
   *
   * 🔴 `uuid()` IS A SECURITY GUARD, NOT A TIDINESS ONE — see the field note above:
   * these are ids the CLIENT says it uploaded, and nothing here proves the object
   * exists or belongs to this user. The shape is the one thing this request CAN
   * check, and it is checkable because EVERY mint on this surface emits
   * `randomUUID()`. There are THREE, enumerated rather than sampled — the
   * enumeration is the load-bearing half of the argument, so a partial one would
   * not support the conclusion:
   *   1. `src/pages/api/v1/image-upload/index.ts:19`           — the presign
   *   2. `src/pages/api/v1/image-upload/multipart/index.ts:21` — multipart
   *   3. `uploadImageBufferToStore` (`src/utils/s3-utils.ts:200`) — the relay fallback
   * Feedback itself reaches only 1 and 3 (`useCFImageUpload` → the presign, falling
   * back to `/api/v1/image-upload/relay`), but 2 is listed so a later change that
   * routes feedback through multipart does not have to re-derive that it is safe.
   * A legitimate id is therefore always a uuid.
   *
   * What the previous LENGTH-ONLY bound (`z.string().trim().min(1).max(100)`) let
   * through is the point. The moderator queue renders these as inline thumbnails and
   * its `getEdgeUrl` returns any `http`-prefixed argument VERBATIM, so an id spelled
   * as an absolute URL would be `<img src="https://attacker.example/x.png">` in a
   * moderator's browser — an outbound request handing the reporter a read receipt
   * naming which moderator opened their report and when.
   *
   * 🔴 THIS GUARD BINDS ONLY ROWS WRITTEN AFTER IT SHIPPED, AND THAT IS WHY
   * `apps/moderator/src/lib/feedback.ts`'s `IMAGE_KEY` REGEX MUST NOT BE DELETED AS
   * REDUNDANT. Every row already in the `Feedback` table was written under the
   * length-only bound and is unvalidated; the moderator reads the same JSONB column
   * for all of them. `IMAGE_KEY` is what actually closes the class today, for
   * historical rows as well as new ones — this schema is a SECOND guard at the other
   * end of a cross-deployable seam, not a replacement for it. Any future consumer of
   * `Feedback.context.images` must filter for itself rather than inferring the shape
   * from this line.
   *
   * 🔴 IT IS STILL NOT AN OWNERSHIP CHECK. Nothing records which user a key was
   * issued to — the presign mints a bare `randomUUID()` and registers only
   * `{uuid, backend, sizeBytes}` with storage-resolver — so a user who learns
   * another user's id can still cite it. Closing that needs a persisted grant at
   * mint time, which is a change to a shared upload route, not to this schema.
   *
   * ⚠ SECOND, SMALLER BEHAVIOUR CHANGE, named rather than bundled: `.trim()` is
   * GONE, so a whitespace-padded id that previously parsed (and was stored trimmed)
   * now REJECTS. Nobody asked for that — it is a choice made here, on the grounds
   * that `z.string().trim().uuid()` would accept ` <uuid> ` and no caller sends one.
   * Restoring `.trim()` is safe if a caller ever turns out to.
   *
   * `z.uuid()`, not the deprecated `z.string().uuid()` (zod 4).
   */
  images: z.array(z.uuid()).max(FEEDBACK_IMAGE_MAX_COUNT).optional(),
  /**
   * Image id of the opt-in page capture. Kept separate from `images` so triage can
   * tell a rendered screenshot of the reporter's own screen from a file they chose
   * to send — the two carry different privacy weight. Same guard as `images`.
   */
  screenshotId: z.uuid().optional(),
  /** Grafana Faro session id, to join a report to that session's RUM signals. */
  sessionId: z.string().trim().min(1).max(FEEDBACK_SESSION_ID_MAX_LENGTH).optional(),
});

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export const createFeedbackSchema = z.object({
  area: feedbackAreaSchema,
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  context: feedbackContextSchema.optional(),
});

export type GetFeedbackAreaInput = z.infer<typeof getFeedbackAreaSchema>;
export const getFeedbackAreaSchema = z.object({ area: feedbackAreaSchema });
