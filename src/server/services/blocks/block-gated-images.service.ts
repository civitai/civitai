import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
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
 *   - above-ceiling / flagged / hard-blocked / scan-refused → `hidden` (NO url),
 *   - not yet rated → `pending` (NO url) for everyone EXCEPT the image's own
 *     author, who gets it `visible` + `ratingPending` (url, no rating claim),
 *   - within-ceiling + scanned + unflagged → the moderated projection.
 * The load-bearing per-row decision is {@link classifyGatedImageForViewer} (pure,
 * unit-tested); an unclamped `getEdgeUrl` is NEVER returned for a hidden image.
 */

/** Bound the read — a grid page never needs more, and each id is a row lookup. */
export const BLOCK_GATED_IMAGES_MAX_IDS = 100;

/** The gated edge-url width (matches the block image-upload gate's projection). */
const GATED_IMAGE_EDGE_WIDTH = 1200;

/**
 * The per-viewer projection returned to a block. `visible` carries the display
 * data (incl. a gated edge url); `pending` and `hidden` carry ONLY the id +
 * status — the block can NEVER obtain the url for either.
 * Mirrors `@civitai/app-sdk/blocks`' `BlockGatedImage` — keep in lockstep.
 *
 * 🔴 THREE STATES, BECAUSE TWO COULD NOT TELL THE TRUTH. `hidden` used to mean
 * both "a rating exists and it is not for you" AND "nothing has rated this yet",
 * so a block had one token to render and guessed: a lighthouse published seconds
 * earlier came back `hidden` and was displayed as *"Hidden — rated mature"* — a
 * rating claim about an unrated image, which a page reload then contradicted the
 * moment the scan landed. `pending` is that second meaning, named.
 *
 * 🔴 `ratingPending` IS A VISIBLE-WITH-NO-RATING, AND IT IS OWNER-ONLY. When the
 * requesting viewer IS the image's author, their own not-yet-rated image comes
 * back `visible` WITH the url and WITHOUT `nsfwLevel`/`contentRating` — show the
 * pixels, claim no rating. This grants the author nothing they did not already
 * hold: the row exists only because THEIR workflow produced it and they
 * confirmed the publish, and the block already received that image's
 * orchestrator url from its own `pollWorkflow`. For every OTHER viewer an
 * unrated image is `pending` with no url — byte-identical withholding to the
 * `hidden` it used to return.
 *
 * 🔴 `nsfwLevel`/`contentRating` ARE OPTIONAL ON `visible` FOR THAT REASON ONLY.
 * They are present on every rated image exactly as before, and absent ONLY on an
 * owner's `ratingPending` entry. A consumer must not read them as "rated G" when
 * missing — that is the bug this type change exists to stop.
 */
export type BlockGatedImage =
  | {
      imageId: number;
      status: 'visible';
      url: string;
      width: number | null;
      height: number | null;
      /** Absent ⇔ `ratingPending` — the scan has not produced a rating yet. */
      nsfwLevel?: number;
      /** Absent ⇔ `ratingPending`. Never synthesized from a 0 level. */
      contentRating?: OffsiteRatingValue;
      /** Present ONLY on the viewer's OWN not-yet-rated image. */
      ratingPending?: true;
    }
  | { imageId: number; status: 'pending' }
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
  /** The image's AUTHOR. Read for ONE decision: may this viewer see their own
   *  not-yet-rated image (see `ratingPending` on {@link BlockGatedImage}). */
  userId: number;
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
  /** The requesting viewer — sources their blocked-users / blocked-tags sets,
   *  and decides the one owner branch (`ratingPending`) below. */
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
      i."id", i."userId", i."url", i."nsfwLevel", i."ingestion", i."width", i."height",
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
    if (verdict.status === 'pending') {
      // 🔴 THE ONE IDENTITY BRANCH, AND IT LIVES HERE RATHER THAN IN THE PURE
      // CLAMP. Nothing has rated this image yet. Its AUTHOR may see it — they
      // generated it, they confirmed the publish, and their block already holds
      // the same picture's orchestrator url from `pollWorkflow`, so the gated
      // edge url adds no reach. Every other viewer gets `pending` with NO url:
      // identical withholding to the `hidden` this case used to return, now
      // merely saying WHY, so a grid can render "still processing" instead of
      // inventing a maturity rating.
      if (row.userId !== input.userId) {
        images.push({ imageId: id, status: 'pending' });
        continue;
      }
      images.push({
        imageId: id,
        status: 'visible',
        ratingPending: true,
        // No `nsfwLevel` / `contentRating`: there is no rating to report, and
        // deriving one from the 0 level would re-assert the very claim this
        // whole change exists to stop.
        url: getEdgeUrl(row.url, { width: GATED_IMAGE_EDGE_WIDTH }),
        width: row.width,
        height: row.height,
      });
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
