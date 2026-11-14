import { env } from '~/env/server';
import { MINI_MODERATION_EXPIRES_MS } from '~/server/utils/mini-moderation-state';
import { blobUrlUsableUntil } from '~/shared/orchestrator/blob-url';

/**
 * How far below the reuse floor a link's refresh lands. Below, not above: a mint reuses a link with
 * at least `DOWNLOAD_LINK_MIN_REUSE_SECONDS` left, so a refresh any earlier would be handed the same
 * link back with an `X-Expires` already past, and reload on every read until the floor.
 */
const LINK_REFRESH_BELOW_REUSE_MS = 10 * 60 * 1000;

/**
 * Mini's `X-Expires` (ms): when the orchestrator's cached copy of the response goes stale, the
 * earliest of `alreadySet`, the moderation block's hour, the re-signed epoch URL's usable-until and
 * the download link's refresh point. Undefined when none applies.
 */
export function miniResponseExpiresAt({
  now,
  alreadySet,
  moderation,
  epochUrl,
  downloadLinkExpiresAt,
}: {
  now: number;
  /** An `X-Expires` the endpoint wrapper already set (a stale `?etag`). */
  alreadySet?: number;
  moderation: boolean;
  /** The re-signed epoch URL, when the response carries one. */
  epochUrl?: string;
  downloadLinkExpiresAt?: number;
}): number | undefined {
  const candidates: number[] = [];
  if (alreadySet !== undefined && !isNaN(alreadySet)) candidates.push(alreadySet);
  if (moderation) candidates.push(now + MINI_MODERATION_EXPIRES_MS);
  const epochUsableUntil = epochUrl ? blobUrlUsableUntil(epochUrl) : undefined;
  if (epochUsableUntil !== undefined) candidates.push(epochUsableUntil);
  if (downloadLinkExpiresAt !== undefined)
    candidates.push(
      downloadLinkExpiresAt -
        Math.max(0, env.DOWNLOAD_LINK_MIN_REUSE_SECONDS * 1000 - LINK_REFRESH_BELOW_REUSE_MS)
    );
  return candidates.length ? Math.min(...candidates) : undefined;
}
