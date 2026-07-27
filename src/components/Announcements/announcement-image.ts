import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

/**
 * Shared, isomorphic helpers for the announcement banner image.
 *
 * `Announcement.metadata.image` is a **bare object key** (not an `Image` row id and
 * not a full URL). Both the renderer (`Announcement.tsx`) and the health monitor
 * (`~/server/jobs/announcement-media-check`) resolve it through this module so the
 * two cannot drift apart — a monitor that checks a variant nobody loads is a monitor
 * that lies.
 */

/**
 * The width `Announcement.tsx` renders the banner at. Load-bearing: the edge URL
 * that users actually request is derived from this number, so the monitor must use
 * the same value.
 */
export const ANNOUNCEMENT_IMAGE_WIDTH = 200;

/**
 * The exact variant URL a browser requests for an announcement banner.
 *
 * Mirrors what `useEdgeUrl` computes for `<EdgeMedia src={key} width={ANNOUNCEMENT_IMAGE_WIDTH} />`:
 *  - `useEdgeUrl` forces `optimized=true` for any width <= 450, and
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
 * Normalise the form value back to the persisted wire format: a bare object key, or
 * `undefined` when there is no image. Never emits `null` — `announcementMetaSchema`
 * types `image` as `z.string().optional()`.
 */
export function toAnnouncementImageKey(
  value: AnnouncementImageFormValue
): string | undefined {
  if (typeof value === 'string') return value;
  return value?.url;
}
