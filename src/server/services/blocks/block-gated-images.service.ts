import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  contentRatingFromNsfwLevel,
  sfwBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { isImageNotRestricted } from '~/server/common/image-visibility';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { heldUrlSql } from '@civitai/shared/held-url';
import {
  BLOCK_GENERATION_SOURCE_APP_ID_META_KEY,
  BLOCK_PUBLISHED_APP_ID_META_KEY,
  BLOCK_SHARED_UPLOAD_APP_ID_META_KEY,
} from '~/shared/utils/block-provenance-metadata';

/**
 * App Blocks (Phase-1 seam) — cross-user gated image read for
 * `blocks.getImagesByIds` (`GET_IMAGES_BY_IDS`). Given a set of image ids (the
 * ids a benchmark grid stored) + the REQUESTING viewer, returns a per-viewer
 * `BlockGatedImage` for each RESOLVABLE id.
 *
 * SECURITY — the read is scoped to bare (`postId IS NULL`) images whose
 * {@link BLOCK_PUBLISHED_APP_ID_META_KEY} or {@link BLOCK_SHARED_UPLOAD_APP_ID_META_KEY}
 * EQUALS the caller's verified appId, plus the viewer's OWN rows whose
 * {@link BLOCK_GENERATION_SOURCE_APP_ID_META_KEY} equals it (see the generation-source note
 * below). 🔴 NEVER `blockUploadedAppId`: the app's own
 * bytes uploads carry it with no share and no dialog. On top of that, the per-viewer
 * clamp (mirroring canonical `getAllImages`' non-owner path) applies:
 *   - blocked-users / blocked-tags → EXCLUDED at the query level (omitted),
 *   - above-ceiling / flagged / hard-blocked / scan-refused → `hidden` (NO url),
 *   - not yet rated → `hidden` (NO url) for everyone EXCEPT the image's own
 *     author, who gets it `visible` + `ratingPending` (url, no rating claim),
 *   - within-ceiling + scanned + unflagged → the moderated projection.
 * The load-bearing per-row decision is {@link classifyGatedImageForViewer} (pure,
 * unit-tested); an unclamped `getEdgeUrl` is NEVER returned for a hidden image.
 *
 * 🔴 A SHARED-UPLOAD ROW (only the shared key matches) is judged at the viewer's
 * ceiling INTERSECTED WITH SFW, with no `ratingPending` owner branch: `pending` is
 * `hidden` for everyone, its uploader included.
 *
 * 🔴 A GENERATION-SOURCE ROW ({@link BLOCK_GENERATION_SOURCE_APP_ID_META_KEY}, an output the app
 * kept privately with no publish confirm) is NOT cross-user: the SQL admits it only for its own
 * author, from the app that kept it, and never when its url is held. Anything the clamp would not
 * show is omitted rather than reported `hidden`.
 */

/** Bound the read — a grid page never needs more, and each id is a row lookup. */
export const BLOCK_GATED_IMAGES_MAX_IDS = 100;

/** The gated edge-url width (matches the block image-upload gate's projection). */
const GATED_IMAGE_EDGE_WIDTH = 1200;

/**
 * The per-viewer projection returned to a block. `visible` carries the display
 * data (incl. a gated edge url); `hidden` carries ONLY the id + status — the
 * block can NEVER obtain the url for it.
 * Mirrors `@civitai/app-sdk/blocks`' `BlockGatedImage` — keep in lockstep. That
 * lockstep is ENFORCED, not merely asked for: the drift guard is
 * `src/server/services/blocks/blockGatedImageSdkParity.ts`, which imports the
 * installed SDK declaration and fails the TYPECHECK (not a test run — it is deliberately
 * not a `*.test.ts`, so it sits in the `tsc --noEmit` / `next build` graph) when
 * the two disagree.
 *
 * 🔴 STILL EXACTLY TWO WIRE STATUSES — `pending` IS NOT ONE OF THEM, BY
 * DECISION. The per-row verdict {@link classifyGatedImageForViewer} does have a
 * third state (`pending` — nothing has rated this image yet), but it is consumed
 * HERE and never emitted: a non-author sees the same `hidden` token they saw
 * before this change, so the cross-user wire shape is TOKEN-identical to the old
 * behaviour, not merely byte-identical in its withholding. Emitting `pending` to
 * a non-author would have ADDED a disclosure bit — post-change `hidden` would
 * then positively assert "a rating exists and it is above your ceiling", letting
 * a SFW viewer of a shared grid enumerate which cells are mature-or-flagged
 * rather than merely unscanned. Nobody asked for a "still processing" placeholder
 * on other people's cells; the defect being fixed is about the AUTHOR's own
 * freshly-published image, so the fix stays on the author's path.
 *
 * 🔴 `ratingPending` IS A VISIBLE-WITH-NO-RATING, AND IT IS OWNER-ONLY — it is
 * the ONLY thing this change puts on the wire. When the requesting viewer IS the
 * image's author, their own not-yet-rated image comes back `visible` WITH the url
 * and WITHOUT `nsfwLevel`/`contentRating` — show the pixels, claim no rating.
 * This grants the author nothing they did not already hold: the row exists only
 * because THEIR workflow produced it and they confirmed the publish (or, for a
 * generation source, their app kept it for them), and the block already received
 * that image's orchestrator url from its own `pollWorkflow`. Every OTHER viewer
 * gets `hidden` for a published row, exactly as before, and nothing at all for a
 * row only its generation-source key admits.
 *
 * 🔴 `nsfwLevel`/`contentRating` ARE OPTIONAL ON `visible` FOR THAT REASON ONLY,
 * and that IS a wire break for a deployed block. They are present on every rated
 * image exactly as before, and absent ONLY on an owner's `ratingPending` entry —
 * so a block that dereferences them on a `visible` entry can now read
 * `undefined`. A consumer must not read a missing value as "rated G"; that is the
 * bug this type change exists to stop. The known consumer is
 * `civitai-app-gen-matrix` (`MaturityImage.tsx`, `App.tsx`, `gallery.ts`).
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
  | { imageId: number; status: 'hidden' };

// The viewer's browsing-level ceiling lives in its own pure module, so the App Blocks
// output ceiling (`blockOutputCeilingFromClaims`) reads the same level without this
// service's database graph. Re-exported here for its existing callers.
export { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-viewer-ceiling';

/**
 * Raw row read from Postgres for the clamp decision. `userId` is the image's AUTHOR: the viewer
 * may see their own not-yet-rated image (see `ratingPending` on {@link BlockGatedImage}) and their
 * own restricted one.
 */
type GatedImageRow = Pick<
  Selectable<DB['Image']>,
  | 'id'
  | 'userId'
  | 'url'
  | 'nsfwLevel'
  | 'ingestion'
  | 'width'
  | 'height'
  | 'needsReview'
  | 'poi'
  | 'minor'
  | 'tosViolation'
  | 'acceptableMinor'
  | 'blockedFor'
  | 'modelRestricted'
> & {
  /** The PUBLISHED key matches this app. Otherwise {@link BLOCK_SHARED_UPLOAD_APP_ID_META_KEY}
   *  or {@link BLOCK_GENERATION_SOURCE_APP_ID_META_KEY} did (see the module note). */
  viaPublished: boolean | null;
  /** {@link BLOCK_GENERATION_SOURCE_APP_ID_META_KEY} matches this app. True whenever it matches,
   *  whichever arm of the SQL admitted the row, so the caller still checks the owner. */
  viaSource: boolean | null;
};

export async function getBlockGatedImagesByIds(input: {
  imageIds: number[];
  browsingLevel: number;
  /** OauthClient id of the CALLING app — scopes the read to images IT published or was allowed to
   *  share, and to the viewer's own generation sources it kept. */
  appId: string;
  /** The requesting viewer: sources their blocked-users / blocked-tags sets, and the owner exceptions. */
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

  // Bare rows scoped by equality to the verified appId: keeps the bridge from being a
  // cross-app / orphaned-row read oracle.
  const rows = await dbRead.$queryRaw<GatedImageRow[]>`
    SELECT
      i."id", i."userId", i."url", i."nsfwLevel", i."ingestion", i."width", i."height",
      i."needsReview", i."poi", i."minor", i."tosViolation", i."acceptableMinor", i."blockedFor",
      i."modelRestricted",
      (i."metadata"->>(${BLOCK_PUBLISHED_APP_ID_META_KEY}::text) IS NOT DISTINCT FROM ${
    input.appId
  })
        AS "viaPublished",
      (i."metadata"->>(${BLOCK_GENERATION_SOURCE_APP_ID_META_KEY}::text) IS NOT DISTINCT FROM ${
    input.appId
  })
        AS "viaSource"
    FROM "Image" i
    WHERE i."id" = ANY(${orderedIds}::int[])
      AND i."postId" IS NULL
      AND (
        i."metadata"->>(${BLOCK_PUBLISHED_APP_ID_META_KEY}::text) = ${input.appId}
        OR i."metadata"->>(${BLOCK_SHARED_UPLOAD_APP_ID_META_KEY}::text) = ${input.appId}
        OR (
          i."metadata"->>(${BLOCK_GENERATION_SOURCE_APP_ID_META_KEY}::text) = ${input.appId}
          AND i."userId" = ${input.userId}
          AND NOT ${Prisma.raw(heldUrlSql('i."url"'))}
        )
      )
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
    if (row.viaPublished !== true && row.viaSource === true && row.userId === input.userId) {
      const source = ownSourceImage(row, input.browsingLevel);
      if (source) images.push(source);
      continue;
    }
    if (!isImageNotRestricted(row, input.userId)) {
      images.push({ imageId: id, status: 'hidden' });
      continue;
    }
    // Fail closed: only a row the SQL positively marked published keeps the published rules;
    // anything else is judged as a shared upload, the stricter of the two.
    const uploadOnly = row.viaPublished !== true;
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
      uploadOnly
        ? Flags.intersection(input.browsingLevel, sfwBrowsingLevelsFlag)
        : input.browsingLevel
    );
    if (verdict.status === 'hidden' || (uploadOnly && verdict.status === 'pending')) {
      images.push({ imageId: id, status: 'hidden' });
      continue;
    }
    if (verdict.status === 'pending') {
      // 🔴 THE PENDING IDENTITY BRANCH LIVES HERE RATHER THAN IN THE PURE
      // CLAMP. Nothing has rated this image yet. Its AUTHOR may see it — they
      // generated it, they confirmed the publish, and their block already holds
      // the same picture's orchestrator url from `pollWorkflow`, so the gated
      // edge url adds no reach.
      //
      // 🔴 EVERY OTHER VIEWER GETS `hidden` — THE VERDICT'S THIRD STATE STOPS
      // HERE AND NEVER REACHES THE WIRE. Not because `pending` would leak the
      // bytes (it carries no url either), but because SAYING SO is itself a
      // disclosure: if unrated cells reported `pending`, then a `hidden` cell
      // would positively assert "a rating exists and it is above your ceiling",
      // and a SFW viewer could enumerate which cells of someone else's grid are
      // mature-or-flagged. Collapsing both into `hidden` keeps the non-author
      // wire shape TOKEN-identical to the pre-change behaviour.
      if (row.userId !== input.userId) {
        images.push({ imageId: id, status: 'hidden' });
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

/**
 * The viewer's own generation source (the SQL bound the row to them), clamped like a published
 * row: a flagged, blocked or above-ceiling source is omitted, an unrated one is `ratingPending`.
 */
function ownSourceImage(row: GatedImageRow, browsingLevel: number): BlockGatedImage | null {
  const verdict = classifyGatedImageForViewer(row, browsingLevel);
  if (verdict.status === 'hidden') return null;
  const shown = {
    url: getEdgeUrl(row.url, { width: GATED_IMAGE_EDGE_WIDTH }),
    width: row.width,
    height: row.height,
  };
  if (verdict.status === 'pending') {
    return { imageId: row.id, status: 'visible', ratingPending: true, ...shown };
  }
  return {
    imageId: row.id,
    status: 'visible',
    nsfwLevel: row.nsfwLevel,
    contentRating: contentRatingFromNsfwLevel(row.nsfwLevel),
    ...shown,
  };
}
