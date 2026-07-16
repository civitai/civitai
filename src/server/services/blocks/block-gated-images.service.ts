import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  contentRatingFromNsfwLevel,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';

/**
 * App Blocks (Phase-1 seam) — cross-user gated image read for
 * `blocks.getImagesByIds` (`GET_IMAGES_BY_IDS`). Given a set of image ids (the
 * ids a benchmark grid stored) and the REQUESTING viewer's browsing-level
 * ceiling, returns a per-viewer `BlockGatedImage` for each RESOLVABLE id.
 *
 * The security boundary is {@link classifyGatedImageForViewer} (pure, unit-
 * tested); this module is the thin dbRead + projection wiring around it. It
 * NEVER returns a raw `getEdgeUrl` for an image the viewer can't see — a
 * `hidden` verdict carries NO url at all.
 */

/** Bound the read — a grid page never needs more, and each id is a row lookup. */
export const BLOCK_GATED_IMAGES_MAX_IDS = 100;

/** The gated edge-url width (matches the block image-upload gate's projection). */
const GATED_IMAGE_EDGE_WIDTH = 1200;

/**
 * The per-viewer projection returned to a block. `visible` carries the moderated
 * display data (incl. a gated edge url); `hidden` carries ONLY the id + status —
 * the block renders a blurred/placeholder cell and can NEVER obtain the url.
 * Mirrors `@civitai/app-sdk/blocks`' `BlockGatedImage` — keep in lockstep.
 */
export type BlockGatedImage =
  | {
      imageId: number;
      status: 'visible';
      nsfwLevel: number;
      contentRating: OffsiteRatingValue;
      url: string;
      width: number | null;
      height: number | null;
    }
  | { imageId: number; status: 'hidden' };

/**
 * Resolve a viewer's effective browsing-level ceiling from the block token's
 * `maxBrowsingLevel` claim (the platform-computed viewer+domain ceiling). Clamped
 * to selectable levels and FAILED CLOSED to the public (PG) floor for an absent /
 * zero / non-selectable value — so a malformed ceiling can only ever HIDE more,
 * never reveal above-level content.
 */
export function resolveViewerBrowsingLevel(maxBrowsingLevel: number | undefined | null): number {
  const selectable = onlySelectableLevels(maxBrowsingLevel ?? 0);
  return selectable || publicBrowsingLevelsFlag;
}

export async function getBlockGatedImagesByIds(input: {
  imageIds: number[];
  browsingLevel: number;
}): Promise<{ images: BlockGatedImage[] }> {
  // Dedupe (preserving first-seen request order) + cap to bound load. Non-finite
  // / non-positive ids are dropped defensively before the query.
  const seen = new Set<number>();
  const orderedIds: number[] = [];
  for (const raw of input.imageIds) {
    if (!Number.isInteger(raw) || raw <= 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    orderedIds.push(raw);
    if (orderedIds.length >= BLOCK_GATED_IMAGES_MAX_IDS) break;
  }
  if (orderedIds.length === 0) return { images: [] };

  // Bare rows ONLY (`postId IS NULL`) — the published benchmark images are
  // post-less, and this least-privilege scope keeps the bridge from becoming a
  // metadata oracle over the site's published gallery (postId-attached) images.
  // The per-viewer clamp below is the real security boundary regardless.
  const rows = await dbRead.image.findMany({
    where: { id: { in: orderedIds }, postId: null },
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      ingestion: true,
      width: true,
      height: true,
      // Moderation flags a `Scanned` ingestion does NOT clear (fail-closed).
      needsReview: true,
      poi: true,
      minor: true,
      tosViolation: true,
      acceptableMinor: true,
    },
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const images: BlockGatedImage[] = [];
  // Iterate in request order; ids that don't resolve to a bare row are OMITTED.
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (!row) continue;
    const verdict = classifyGatedImageForViewer(
      {
        ingestion: row.ingestion,
        nsfwLevel: row.nsfwLevel,
        needsReview: row.needsReview,
        poi: row.poi,
        minor: row.minor,
        tosViolation: row.tosViolation,
        acceptableMinor: row.acceptableMinor,
      },
      input.browsingLevel
    );
    if (verdict.status === 'hidden') {
      images.push({ imageId: id, status: 'hidden' });
      continue;
    }
    images.push({
      imageId: id,
      status: 'visible',
      nsfwLevel: row.nsfwLevel,
      contentRating: contentRatingFromNsfwLevel(row.nsfwLevel),
      // A gated edge url for the (scanned, within-ceiling, unflagged) image — the
      // raw key (`row.url`) NEVER leaves the server.
      url: getEdgeUrl(row.url, { width: GATED_IMAGE_EDGE_WIDTH }),
      width: row.width,
      height: row.height,
    });
  }
  return { images };
}
