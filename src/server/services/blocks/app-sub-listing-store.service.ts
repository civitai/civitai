import { Prisma } from '@prisma/client';

import { getEdgeUrl } from '~/client-utils/edge-url';
import type { PrismaClient } from '@prisma/client';
import type { ListingKind, SubListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import { LISTING_COVER_WIDTH } from '~/server/services/blocks/listing-media-url';
import {
  gatedListingCoverUrl,
  gatedListingIconUrl,
  isListingImageVisible,
  isModerationFlagSet,
  redHostMediaCeiling,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';
import {
  effectiveSubListingRating,
  subListingExternalHref,
  subListingRunHref,
} from '~/shared/constants/app-sub-listing.constants';
import {
  browsingLevels,
  flagifyBrowsingLevel,
  nsfwLevelFromContentRating,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

type SubListingHydrateRow = {
  id: string;
  title: string;
  tagline: string | null;
  sub_path: string;
  content_rating: string | null;
  author_user_id: number;
  author_username: string | null;
  author_image: string | null;
  parent_id: string;
  parent_slug: string;
  parent_name: string;
  parent_kind: string;
  parent_category: string | null;
  parent_content_rating: string | null;
  parent_cover_url: string | null;
  parent_cover_nsfw_level: number | null;
  parent_cover_ingestion: string | null;
  parent_cover_needs_review: string | null;
  parent_cover_poi: boolean | null;
  parent_cover_minor: boolean | null;
  parent_cover_tos_violation: boolean | null;
  parent_cover_acceptable_minor: boolean | null;
  parent_cover_blocked_for: string | null;
  parent_icon_url: string | null;
  parent_icon_nsfw_level: number | null;
  parent_icon_ingestion: string | null;
  parent_icon_needs_review: string | null;
  parent_icon_poi: boolean | null;
  parent_icon_minor: boolean | null;
  parent_icon_tos_violation: boolean | null;
  parent_icon_acceptable_minor: boolean | null;
  parent_icon_blocked_for: string | null;
  parent_link_template: string | null;
  image_url: string | null;
  image_nsfw_level: number | null;
  image_ingestion: string | null;
  image_needs_review: string | null;
  image_poi: boolean | null;
  image_minor: boolean | null;
  image_tos_violation: boolean | null;
  image_acceptable_minor: boolean | null;
  image_blocked_for: string | null;
  /** The item image is in a published, non-private post (see `hydrateSubListingCards`). */
  image_public: boolean | null;
};

/**
 * `app_sub_listing_parents.link_template` for the row aliased `sp`. Read through `to_jsonb` so
 * the statement stays valid before the manual-apply column exists: the value is then NULL, which
 * keeps every off-site parent's children out of the store.
 */
export const PARENT_LINK_TEMPLATE_SQL = Prisma.sql`(to_jsonb(sp) ->> 'link_template')`;

/**
 * The image's post, aliased `p`, is published and not Private: what a card needs before it shows
 * an item image. NULL, so false, for an image with no post. The one definition behind both the
 * card render (`hydrateSubListingCards`) and the publish check (`isImageInPublicPost`). The image
 * picker's `publicOnly` list uses the Prisma form, `publicPostImageWhere` (`image.selector.ts`),
 * which differs only at the boundary instant (`<=` there, `<` here).
 */
const IMAGE_POST_PUBLIC_SQL = Prisma.sql`(p."publishedAt" < now() AND p."availability"::text <> 'Private')`;

/**
 * True when `imageId` is in a published, non-private post. Stricter than `getImage`'s anonymous
 * read, which also serves a postless image that is an article cover or on a bounty: the card
 * would not show such an image, so it is not accepted for one.
 */
export async function isImageInPublicPost(
  db: Pick<PrismaClient, '$queryRaw'>,
  imageId: number
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT i.id FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId} AND ${IMAGE_POST_PUBLIC_SQL}
  `);
  return rows.length > 0;
}

export type SubListingViewer = {
  /** The viewer's own browsing level, when signed in. */
  browsingLevel?: number | null;
  redCapable: boolean;
};

/**
 * The levels an image may carry to be shown to this viewer on one sub-listing card — the item's
 * own image and the parent's cover / icon fallback alike.
 *
 * Off a red-capable host: the viewer's browsing level ∩ SFW ∩ the card's own (effective)
 * rating, so an image there is never more mature than the card that carries it.
 *
 * On a red-capable host: that same non-red ceiling, lifted by the shared listing-media red-host
 * rule (`redHostMediaCeiling`: ∪ the viewer's opted-in levels, Blocked excluded). The card's
 * rating does NOT cap it there — a `pg` item may show its R image to a viewer who opted into R,
 * as the main listing's screenshots do. A viewer who has not opted in, anonymous included, sees
 * exactly what a non-red host shows, never less.
 */
export function subListingImageCeiling(viewer: SubListingViewer, rating: string | null): number {
  const viewerLevel = onlySelectableLevels(viewer.browsingLevel ?? 0) || publicBrowsingLevelsFlag;
  const ratingMax = nsfwLevelFromContentRating(rating);
  const ratingLevels = flagifyBrowsingLevel(browsingLevels.filter((l) => l <= ratingMax));
  return redHostMediaCeiling(
    { redCapable: viewer.redCapable, viewerBrowsingLevel: viewer.browsingLevel },
    viewerLevel & ratingLevels & sfwBrowsingLevelsFlag
  );
}

/**
 * One parent image (`parent_cover_*` / `parent_icon_*`) as the listing-media gate reads it, or
 * null when the parent has none. A row with no `ingestion` (a LEFT JOIN miss) has no image.
 */
function parentImage(row: SubListingHydrateRow, which: 'cover' | 'icon'): ListingMediaImage | null {
  const url = row[`parent_${which}_url` as const];
  const ingestion = row[`parent_${which}_ingestion` as const];
  if (!url || ingestion == null) return null;
  return {
    url,
    ingestion,
    nsfwLevel: row[`parent_${which}_nsfw_level` as const] ?? 0,
    needsReview: row[`parent_${which}_needs_review` as const],
    poi: isModerationFlagSet(row[`parent_${which}_poi` as const]),
    minor: isModerationFlagSet(row[`parent_${which}_minor` as const]),
    tosViolation: isModerationFlagSet(row[`parent_${which}_tos_violation` as const]),
    acceptableMinor: isModerationFlagSet(row[`parent_${which}_acceptable_minor` as const]),
    blockedFor: row[`parent_${which}_blocked_for` as const],
  };
}

/** Null when the card has nowhere valid to link to. */
export function projectSubListingCard(
  row: SubListingHydrateRow,
  viewer: SubListingViewer
): SubListingCard | null {
  const externalHref =
    row.parent_kind === 'offsite'
      ? subListingExternalHref(row.parent_link_template, row.sub_path)
      : null;
  if (row.parent_kind === 'offsite' && !externalHref) return null;
  const contentRating = effectiveSubListingRating(row.parent_content_rating, row.content_rating);
  // ONE ceiling for every image on the card — the item's own image and the parent's cover / icon
  // fallback (see `subListingImageCeiling`; the card rating is the more mature of parent and
  // child).
  const ceiling = subListingImageCeiling(viewer, contentRating);
  const parentCover = gatedListingCoverUrl(parentImage(row, 'cover'), [], ceiling);
  let coverUrl = parentCover;
  // The image was public when it was submitted; this re-checks it on every render, so a post
  // made private or unpublished later stops showing its image on the card.
  if (row.image_url && row.image_ingestion != null && row.image_public) {
    const visible = isListingImageVisible(
      {
        ingestion: row.image_ingestion,
        nsfwLevel: row.image_nsfw_level ?? 0,
        needsReview: row.image_needs_review,
        poi: row.image_poi,
        minor: row.image_minor,
        tosViolation: row.image_tos_violation,
        acceptableMinor: row.image_acceptable_minor,
        blockedFor: row.image_blocked_for,
      },
      ceiling
    );
    // Anything short of `visible` (pending scan included) falls back to the parent cover.
    coverUrl = visible ? getEdgeUrl(row.image_url, { width: LISTING_COVER_WIDTH }) : parentCover;
  }
  return {
    cardType: 'sub-listing',
    id: row.id,
    name: row.title,
    tagline: row.tagline,
    kind: row.parent_kind as ListingKind,
    category: row.parent_category,
    contentRating,
    coverUrl,
    creator: {
      id: row.author_user_id,
      username: row.author_username,
      image: row.author_image,
    },
    parent: {
      id: row.parent_id,
      slug: row.parent_slug,
      name: row.parent_name,
      iconUrl: gatedListingIconUrl(parentImage(row, 'icon'), ceiling),
    },
    ...(externalHref
      ? { runHref: externalHref, external: true as const }
      : { runHref: subListingRunHref(row.parent_slug, row.sub_path, row.id) }),
  };
}

/**
 * Sub-listing rows for the store grid, hydrated live below the catalog cache.
 *
 * Only `approved` rows by authors who are not banned or deleted, and, for an off-site parent, with
 * a usable link template, are returned, so a child that changed after its id was cached drops out
 * on the next render rather than waiting for the cache to expire.
 */
export async function hydrateSubListingCards(
  db: Pick<PrismaClient, '$queryRaw'>,
  ids: string[],
  viewer: SubListingViewer
): Promise<Map<string, SubListingCard>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<SubListingHydrateRow[]>(Prisma.sql`
    SELECT s.id, s.title, s.tagline, s.sub_path, s.content_rating, s.author_user_id,
           u.username AS author_username, u.image AS author_image,
           al.id AS parent_id, al.slug AS parent_slug, al.name AS parent_name,
           al.kind AS parent_kind, al.category AS parent_category,
           al.content_rating AS parent_content_rating,
           pc.url AS parent_cover_url, pc."nsfwLevel" AS parent_cover_nsfw_level,
           pc.ingestion::text AS parent_cover_ingestion,
           pc."needsReview" AS parent_cover_needs_review, pc.poi AS parent_cover_poi,
           pc.minor AS parent_cover_minor, pc."tosViolation" AS parent_cover_tos_violation,
           pc."acceptableMinor" AS parent_cover_acceptable_minor,
           pc."blockedFor" AS parent_cover_blocked_for,
           pi.url AS parent_icon_url, pi."nsfwLevel" AS parent_icon_nsfw_level,
           pi.ingestion::text AS parent_icon_ingestion,
           pi."needsReview" AS parent_icon_needs_review, pi.poi AS parent_icon_poi,
           pi.minor AS parent_icon_minor, pi."tosViolation" AS parent_icon_tos_violation,
           pi."acceptableMinor" AS parent_icon_acceptable_minor,
           pi."blockedFor" AS parent_icon_blocked_for,
           ${PARENT_LINK_TEMPLATE_SQL} AS parent_link_template,
           i.url AS image_url, i."nsfwLevel" AS image_nsfw_level,
           i.ingestion::text AS image_ingestion, i."needsReview" AS image_needs_review,
           i.poi AS image_poi, i.minor AS image_minor,
           i."tosViolation" AS image_tos_violation,
           i."acceptableMinor" AS image_acceptable_minor,
           i."blockedFor" AS image_blocked_for,
           ${IMAGE_POST_PUBLIC_SQL} AS image_public
    FROM app_sub_listings s
    JOIN app_listings al ON al.id = s.parent_listing_id
    JOIN "User" u ON u.id = s.author_user_id
    LEFT JOIN app_sub_listing_parents sp ON sp.parent_listing_id = al.id
    LEFT JOIN "Image" i ON i.id = s.image_id
    LEFT JOIN "Post" p ON p.id = i."postId"
    LEFT JOIN "Image" pc ON pc.id = al.cover_id
    LEFT JOIN "Image" pi ON pi.id = al.icon_id
    WHERE s.id IN (${Prisma.join(ids)})
      AND s.status = 'approved'
      AND u."bannedAt" IS NULL
      AND u."deletedAt" IS NULL
  `);
  const cards = new Map<string, SubListingCard>();
  for (const row of rows) {
    const card = projectSubListingCard(row, viewer);
    if (card) cards.set(row.id, card);
  }
  return cards;
}
