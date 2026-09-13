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
   * check, and it is checkable because both mint paths emit `randomUUID()`: the
   * presign at `src/pages/api/v1/image-upload/index.ts` and the relay fallback's own
   * server-side mint in `uploadImageBufferToStore` (`src/utils/s3-utils.ts`). A
   * legitimate id is therefore always a uuid.
   *
   * What the previous LENGTH-ONLY bound (`z.string().trim().min(1).max(100)`) let
   * through is the point. The moderator queue renders these as inline thumbnails and
   * its `getEdgeUrl` returns any `http`-prefixed argument VERBATIM, so an id spelled
   * as an absolute URL became `<img src="https://attacker.example/x.png">` in a
   * moderator's browser — an outbound request handing the reporter a read receipt
   * naming which moderator opened their report and when.
   * `apps/moderator/src/lib/feedback.ts`'s `IMAGE_KEY` regex closes that on the READ
   * side; this closes it at the source, so the guarantee stops depending on one
   * consumer remembering to filter.
   *
   * 🔴 IT IS STILL NOT AN OWNERSHIP CHECK. Nothing records which user a key was
   * issued to — the presign mints a bare `randomUUID()` and registers only
   * `{uuid, backend, sizeBytes}` with storage-resolver — so a user who learns
   * another user's id can still cite it. Closing that needs a persisted grant at
   * mint time, which is a change to a shared upload route, not to this schema.
   *
   * No `.trim()`: trimming first would accept a whitespace-padded uuid, and no
   * caller sends one. `z.uuid()`, not the deprecated `z.string().uuid()`.
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
