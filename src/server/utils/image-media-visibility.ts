import { Prisma } from '@prisma/client';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { Flags } from '~/shared/utils/flags';

type MediaFields = {
  url: string;
  nsfwLevel: number;
  metadata: ImageMetadata | VideoMetadata | null;
  user: { id: number };
};

type ViewerExemptions = {
  /** The viewer manages a collection judging this image (see `managesImageCollection`). */
  managesCollection?: boolean;
};

/**
 * Whether a single-image response may carry the media itself: the domain cap for the request, on
 * the image's own rating, with the owner, moderators and collection managers always allowed.
 *
 * Close to `Gated`'s page state, but not the same: `Gated` also honours a contest's forced
 * level, lets a rating through on any one allowed bit, and still redirects owners, moderators and
 * managers on the SFW domain. The image page gates on the image's own rating when `url` comes
 * back null, so it never shows a frame the server left empty, except for a mixed rating.
 */
export function canViewImageMedia(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  image: Pick<MediaFields, 'nsfwLevel' | 'user'>,
  { managesCollection }: ViewerExemptions = {}
) {
  if (ctx.user && (ctx.user.isModerator || ctx.user.id === image.user.id)) return true;
  if (managesCollection) return true;
  const cap = requestDomainBrowsingLevelCap(ctx);
  // Every bit of the rating inside the cap: unrated (0) and mixed ratings fail closed.
  return cap === undefined || (image.nsfwLevel !== 0 && Flags.hasFlag(cap, image.nsfwLevel));
}

/**
 * The image as this viewer may receive it: with `url` null and external video ids dropped when
 * the viewer can't see the media. The blur hash, dimensions and rating stay for the gate card.
 */
export function withViewerMedia<T extends MediaFields>(
  ctx: Pick<Context, 'user' | 'features' | 'req' | 'cache'>,
  image: T,
  exemptions?: ViewerExemptions
): Omit<T, 'url'> & { url: string | null } {
  if (canViewImageMedia(ctx, image, exemptions)) {
    // A signed-out answer is edge-cached by URL alone; a crawler's must not reach anyone else.
    const verifiedBot = parseVerifiedBotHeader(ctx.req?.headers[VERIFIED_BOT_HEADER]);
    if (!ctx.user && verifiedBot !== null && ctx.cache) {
      ctx.cache.edgeTTL = 0;
      ctx.cache.browserTTL = 0;
      ctx.cache.staleWhileRevalidate = 0;
    }
    return image;
  }
  if (!image.metadata) return { ...image, url: null };
  const { youtubeVideoId, vimeoVideoId, ...metadata } = image.metadata as VideoMetadata;
  return { ...image, url: null, metadata };
}

/**
 * Whether the user holds MANAGE on a collection judging this image: the collection its post was
 * submitted to (the test `getImage` uses to show a manager an unreviewed entry), or a contest
 * collection holding the image itself. Other collections don't count: anyone can add an image
 * to a collection of their own.
 */
export async function managesImageCollection({
  imageId,
  postId,
  userId,
}: {
  imageId: number;
  postId: number | null;
  userId: number;
}) {
  const rows = await dbRead.$queryRaw<{ managed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "Post" p
      JOIN "CollectionContributor" cc ON cc."collectionId" = p."collectionId"
      WHERE p.id = ${postId}
        AND cc."userId" = ${userId}
        AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    ) OR EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      JOIN "Collection" c ON c.id = ci."collectionId"
      JOIN "CollectionContributor" cc ON cc."collectionId" = ci."collectionId"
      WHERE ci."imageId" = ${imageId}
        AND c.mode = 'Contest'
        AND cc."userId" = ${userId}
        AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    ) AS managed
  `);
  return rows[0]?.managed ?? false;
}
