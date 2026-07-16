import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  contentRatingFromNsfwLevel,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { BLOCK_PUBLISHED_APP_ID_META_KEY } from '~/server/services/blocks/block-image-upload.service';

/**
 * App Blocks (Phase-1 seam) — cross-user gated image read for
 * `blocks.getImagesByIds` (`GET_IMAGES_BY_IDS`). Given a set of image ids (the
 * ids a benchmark grid stored) + the REQUESTING viewer, returns a per-viewer
 * `BlockGatedImage` for each RESOLVABLE id.
 *
 * SECURITY — the read is scoped to images THIS app published (the
 * `metadata.blockPublishedAppId = <caller appId>` provenance marker stamped at
 * publish), so a block can only read its OWN app's grid — never another app's
 * images nor a post-deletion-orphaned bare row. On top of that, the per-viewer
 * clamp (mirroring canonical `getAllImages`' non-owner path) applies:
 *   - blocked-users / blocked-tags → EXCLUDED at the query level (omitted),
 *   - above-ceiling / unscanned / flagged / hard-blocked → `hidden` (NO url),
 *   - within-ceiling + scanned + unflagged → the moderated projection.
 * The load-bearing per-row decision is {@link classifyGatedImageForViewer} (pure,
 * unit-tested); an unclamped `getEdgeUrl` is NEVER returned for a hidden image.
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

/** Raw row shape read from Postgres for the clamp decision. */
type GatedImageRow = {
  id: number;
  url: string;
  nsfwLevel: number;
  ingestion: string;
  width: number | null;
  height: number | null;
  needsReview: string | null;
  poi: boolean | null;
  minor: boolean | null;
  tosViolation: boolean | null;
  acceptableMinor: boolean | null;
  blockedFor: string | null;
};

export async function getBlockGatedImagesByIds(input: {
  imageIds: number[];
  browsingLevel: number;
  /** OauthClient id of the CALLING app — scopes the read to images IT published. */
  appId: string;
  /** The requesting viewer — sources their blocked-users / blocked-tags sets. */
  userId: number;
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

  // The viewer's blocked-users + blocked-tags sets (canonical hidden-prefs) —
  // excluded at the query level exactly like getAllImages' non-owner path.
  const hidden = await getAllHiddenForUser({ userId: input.userId });
  const excludedUserIds = [
    ...hidden.hiddenUsers,
    ...hidden.blockedUsers,
    ...hidden.blockedByUsers,
  ].map((u) => u.id);
  const excludedTagIds = hidden.hiddenTags.filter((t) => t.hidden).map((t) => t.id);

  // Canonical blocked-user fragment: `i."userId" != ALL(excludedUserIds)`.
  const excludedUserFrag = excludedUserIds.length
    ? Prisma.sql`AND i."userId" != ALL(${excludedUserIds}::int[])`
    : Prisma.empty;
  // Canonical blocked-browsing-tags fragment: NOT EXISTS an enabled TagsOnImage
  // detail row for one of the viewer's excluded tags (matches image.service.ts).
  const excludedTagFrag = excludedTagIds.length
    ? Prisma.sql`AND NOT EXISTS (
        SELECT 1 FROM "TagsOnImageDetails" toi
        WHERE toi."imageId" = i."id"
          AND toi."tagId" IN (${Prisma.join([...new Set(excludedTagIds)])})
          AND toi."disabled" = FALSE
      )`
    : Prisma.empty;

  // Bare rows ONLY (`postId IS NULL`) AND scoped to images THIS app published
  // (the provenance marker) — so the bridge is never a cross-app / orphaned-row
  // read oracle. The per-row clamp below is the maturity security boundary.
  const rows = await dbRead.$queryRaw<GatedImageRow[]>`
    SELECT
      i."id", i."url", i."nsfwLevel", i."ingestion", i."width", i."height",
      i."needsReview", i."poi", i."minor", i."tosViolation", i."acceptableMinor", i."blockedFor"
    FROM "Image" i
    WHERE i."id" = ANY(${orderedIds}::int[])
      AND i."postId" IS NULL
      AND i."metadata"->>(${BLOCK_PUBLISHED_APP_ID_META_KEY}::text) = ${input.appId}
      ${excludedUserFrag}
      ${excludedTagFrag}
  `;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const images: BlockGatedImage[] = [];
  // Iterate in request order; ids that don't resolve (not this app's, blocked
  // user/tag, or nonexistent) are OMITTED.
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
        blockedFor: row.blockedFor,
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
