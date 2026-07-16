import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * App Blocks (Phase-1 seam) — the PURE per-VIEWER display decision for the
 * cross-user gated image read (`blocks.getImagesByIds` → `GET_IMAGES_BY_IDS`),
 * extracted so the load-bearing moderation clamp is unit-testable in the node
 * vitest env (no Prisma / no dbRead — mirrors `block-image-upload.logic.ts`).
 *
 * A benchmark grid stores the ids of images ONE user published (via
 * `blocks.publishGenerationOutputs`) and asks the host to render them for EVERY
 * viewer. This decides, for the REQUESTING viewer, whether an image is:
 *   - `visible` — scanned clean, unflagged, AND within THIS viewer's browsing-
 *     level ceiling → the host returns the moderated projection (incl. a gated
 *     edge url).
 *   - `hidden`  — withheld from this viewer (not-yet-scanned, unrated, flagged,
 *     or above their browsing ceiling). The host returns NO url — the block
 *     renders a blurred/placeholder cell. This is the cross-user moderation
 *     boundary: an unclamped edge url NEVER crosses to a viewer who can't see it.
 *
 * The clamp mirrors the non-owner path of `getAllImages` (the site's canonical
 * image read): `(nsfwLevel & browsingLevel) != 0 AND nsfwLevel != 0` plus the
 * `needsReview IS NULL` / `acceptableMinor = FALSE` guards, AND additionally
 * requires a terminal `Scanned` ingestion + fails closed on every moderation
 * flag a `Scanned` ingestion does NOT clear (`needsReview`/`poi`/`minor`/
 * `tosViolation`) — the same fail-closed posture as the block image-upload gate,
 * because these images are shown PUBLICLY with no per-image mod review.
 *
 * DELIBERATELY STRICTER than "excluded for non-owners": there is NO owner bypass
 * here — an unscanned/flagged image is `hidden` for EVERYONE (including its
 * author) until it clears. That is a safe over-restriction (it never LEAKS), and
 * it keeps the decision a pure function of the row + the viewer's ceiling with no
 * identity branch to get wrong.
 */
export type GatedImageVerdict = { status: 'visible' } | { status: 'hidden' };

/**
 * Pure gate decision for ONE image against a viewer's browsing-level flag.
 * `browsingLevel` is the viewer's already-resolved ceiling (a browsing-level
 * bitmask; the caller intersects the block token's `maxBrowsingLevel` with the
 * public floor and fails closed to PG — a `0`/empty ceiling here hides
 * everything). Fail-closed on every uncertain state.
 */
export function classifyGatedImageForViewer(
  image: {
    ingestion: ImageIngestionStatus | string;
    nsfwLevel: number;
    /** Moderation flags a `Scanned` ingestion does NOT clear. */
    needsReview?: string | null;
    poi?: boolean | null;
    minor?: boolean | null;
    tosViolation?: boolean | null;
    acceptableMinor?: boolean | null;
    /** Non-null once the image has been hard-blocked (a moderation-block reason). */
    blockedFor?: string | null;
  },
  browsingLevel: number
): GatedImageVerdict {
  const { ingestion, nsfwLevel } = image;

  // Must be terminally Scanned — Pending / Error / Blocked / NotFound all hide.
  if (ingestion !== ImageIngestionStatus.Scanned) return { status: 'hidden' };

  // An unscanned/unrated level (0) carries no maturity signal → never cross it
  // to another viewer (mirrors getAllImages' `nsfwLevel != 0`).
  if (nsfwLevel === 0) return { status: 'hidden' };

  // Any moderation flag → hidden (public, un-mod-reviewed image fails closed).
  // `blockedFor` is the hard-block reason (a Scanned row can still be blocked).
  if (
    image.needsReview != null ||
    image.poi === true ||
    image.minor === true ||
    image.tosViolation === true ||
    image.acceptableMinor === true ||
    image.blockedFor != null
  ) {
    return { status: 'hidden' };
  }

  // Per-viewer browsing-level clamp: the image's level must intersect the
  // viewer's ceiling, else it's above what THIS viewer may see → hidden.
  if (!Flags.intersects(nsfwLevel, browsingLevel)) return { status: 'hidden' };

  return { status: 'visible' };
}
