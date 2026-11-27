import { getEdgeUrl } from '~/client-utils/edge-url';
import { imageRatingOfNsfwLevel } from '~/shared/constants/browsingLevel.constants';
import type { BlockOutputCeiling } from '~/server/services/blocks/block-output-restriction';
import type { BlockWorkflowOutputRating } from '~/server/schema/blocks/workflow.schema';
import { isBlobUrl } from '~/utils/type-guards';

/**
 * The VIEWER's own avatar, as an App Block may see it: on `GET /api/v1/blocks/me`, its
 * bridge twin `blocks.getMyViewer`, and `BLOCK_INIT.viewer.image` (the token mint computes
 * it and the host forwards it). All three call {@link projectBlockViewerImage}, so the rule
 * lives here once.
 *
 *   - `{ url, nsfwLevel }` — a ready-to-render CDN url and the picture's rating, in the
 *     same vocabulary as a workflow output's `nsfwLevel` (`pg` … `xxx`).
 *   - `{ restricted: true, reason }` — the viewer HAS an avatar the app may not be given:
 *     `'ceiling'` when its rating is above the token's output ceiling, `'unrated'` while
 *     it has no rating (still being scanned, a scan error, or a legacy avatar url that
 *     was never rated). No url, no rating — the same shape a restricted output has.
 *   - `null` — no avatar to show (none set, or the picture was blocked by moderation,
 *     which the site also renders as no picture).
 */
export type BlockViewerImage =
  | { url: string; nsfwLevel: BlockWorkflowOutputRating }
  | { restricted: true; reason: 'ceiling' | 'unrated' }
  | null;

/** Render width of the avatar url: a rung of the image CDN's width ladder (`COMMON_IMAGE_WIDTHS`). */
export const BLOCK_VIEWER_IMAGE_WIDTH = 320;

/** The `User` fields {@link projectBlockViewerImage} reads. Spread into a `user` select. */
export const blockViewerImageUserSelect = {
  image: true,
  profilePicture: {
    select: { url: true, nsfwLevel: true, ingestion: true },
  },
} as const;

export type BlockViewerImageSource = {
  /** Legacy avatar url (`User.image`). Never rated. */
  image?: string | null;
  profilePicture?: {
    url: string;
    nsfwLevel: number;
    ingestion: string;
  } | null;
};

/**
 * The viewer's avatar for an app, judged against the token's OUTPUT ceiling
 * (`blockOutputCeilingFromClaims`) — the same ceiling that decides whether a workflow
 * output may be handed to the app (`classifyBlockOutput`, rule 3). Fails closed: only a
 * SCANNED picture with exactly one known rating inside the ceiling gets a url.
 *
 * The owner exemption the site's own avatar component has (an owner sees their own
 * pending picture) does NOT apply: the reader here is a third-party app, not the owner.
 */
export function projectBlockViewerImage(
  user: BlockViewerImageSource | null | undefined,
  ceiling: BlockOutputCeiling
): BlockViewerImage {
  const picture = user?.profilePicture;
  if (picture && typeof picture.url === 'string' && picture.url && !isBlobUrl(picture.url)) {
    if (picture.ingestion === 'Blocked') return null;
    if (picture.ingestion !== 'Scanned') return { restricted: true, reason: 'unrated' };
    if (!picture.nsfwLevel) return { restricted: true, reason: 'unrated' };
    const rating = imageRatingOfNsfwLevel(picture.nsfwLevel);
    // Blocked (32), a multi-bit flag, or an unknown level: no rating to judge, fail closed.
    if (rating === null) return { restricted: true, reason: 'ceiling' };
    if ((picture.nsfwLevel & ceiling.maxBrowsingLevel) === 0) {
      return { restricted: true, reason: 'ceiling' };
    }
    return {
      url: getEdgeUrl(picture.url, {
        width: BLOCK_VIEWER_IMAGE_WIDTH,
        anim: false,
        optimized: true,
      }),
      nsfwLevel: rating,
    };
  }
  // No usable profile picture. A legacy `User.image` url has no rating at all.
  if (typeof user?.image === 'string' && user.image && !isBlobUrl(user.image)) {
    return { restricted: true, reason: 'unrated' };
  }
  return null;
}
