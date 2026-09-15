import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/edge-url';

/**
 * Shared, isomorphic helpers for the announcement banner image.
 *
 * `Announcement.metadata.image` is a **bare object key** (not an `Image` row id and
 * not a full URL). Both the renderer (`Announcement.tsx`) and the health monitor
 * (`~/server/jobs/announcement-media-check`) resolve it through this module so the
 * two cannot drift apart — a monitor that checks a variant nobody loads is a monitor
 * that lies.
 *
 * Imports the **React-free** `~/client-utils/edge-url` rather than `cf-images-utils`,
 * so the server job that pulls this module in does not transitively import
 * `useCurrentUser` / `BrowserSettingsProvider`. A module-scope `window` access
 * anywhere in that chain would crash the import of the run-jobs endpoint and take
 * down every job, not just this one.
 */

/**
 * The width `AnnouncementCard.tsx` renders the banner at. Load-bearing: the edge URL
 * that users actually request is derived from this number, so the monitor must use
 * the same value.
 */
export const ANNOUNCEMENT_IMAGE_WIDTH = 200;

/**
 * The exact variant URL a browser requests for an announcement banner.
 *
 * Mirrors what `useEdgeUrl` computes for `<EdgeMedia src={key} width={ANNOUNCEMENT_IMAGE_WIDTH} />`:
 *  - `AnnouncementCard.tsx` passes `optimized` explicitly, which `resolveOptimized` honours ahead
 *    of the viewer's media quality, so the banner has ONE variant the monitor can name. A renderer
 *    that stopped passing it would leave the monitor probing a variant nobody loads; and
 *  - `getEdgeUrl` snaps the width up the common-size ladder (200 -> 320).
 *
 * Do NOT substitute `{ original: true }` here. The original object and the derived
 * variant are different cache/derivation paths — the original can serve 200 while
 * the variant users load 404s, which is precisely how the outage this monitors for
 * went unnoticed.
 */
export function getAnnouncementImageUrl(key: string) {
  return getEdgeUrl(key, { width: ANNOUNCEMENT_IMAGE_WIDTH, optimized: true });
}

/**
 * Form-state shape for the announcement banner field.
 *
 * The upload widget (`SimpleImageUpload`) emits an object (`{ url, ... }`) on
 * success and `null` on remove, while an announcement being edited loads the stored
 * **bare key string**. Accept all three here and normalise on submit — the persisted
 * `metadata.image` must stay a bare key string.
 */
export const announcementImageFormSchema = z
  .union([z.string(), z.object({ url: z.string() }).passthrough()])
  .nullish();

export type AnnouncementImageFormValue = z.infer<typeof announcementImageFormSchema>;

/**
 * The form's initial value for the banner field, read off a loaded announcement.
 *
 * Explicit (rather than an inline `announcement?.metadata?.image`) so the load leg of
 * the round-trip is testable: `toAnnouncementImageKey(parse(toAnnouncementImageFormValue(m)))`
 * must return the stored key byte-identically, or editing an existing announcement and
 * saving it unchanged would silently rewrite `metadata.image`.
 */
export function toAnnouncementImageFormValue(
  metadata?: { image?: string } | null
): AnnouncementImageFormValue {
  return metadata?.image;
}

/**
 * Normalise the form value back to the persisted wire format: a bare object key, or
 * `undefined` when there is no image. Never emits `null` — `announcementMetaSchema`
 * types `image` as `z.string().optional()`.
 */
export function toAnnouncementImageKey(value: AnnouncementImageFormValue): string | undefined {
  if (typeof value === 'string') return value;
  return value?.url;
}
