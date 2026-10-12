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
  /** The viewer manages the collection the image's post was submitted to (e.g. contest judges). */
  managesCollection?: boolean;
};

/**
 * Whether a single-image response may carry the media: the request's domain cap on the image's own
 * rating, always allowed for the owner, moderators and collection managers. Not identical to
 * `Gated`: it ignores a contest's forced level and withholds mixed ratings.
 */
export function canViewImageMedia(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  image: Pick<MediaFields, 'nsfwLevel' | 'user'>,
  { managesCollection }: ViewerExemptions = {}
) {
  if (ctx.user && (ctx.user.isModerator || ctx.user.id === image.user.id)) return true;
  if (managesCollection) return true;
  const cap = requestDomainBrowsingLevelCap(ctx);
  // Under a cap, every bit of the rating must be inside it; unrated (0) and mixed ratings fail closed.
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
    // Signed-out answers are edge-cached by URL alone; a crawler's must not be served to others.
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
 * Whether the user holds MANAGE on the collection the image's post was submitted to. Only the
 * post's author (or a moderator) chooses that collection, so the post must also belong to the
 * image's owner. Membership of a collection does not count: anyone can create one, of any mode,
 * and add any image to it.
 */
export async function managesPostCollection({
  postId,
  imageOwnerId,
  userId,
}: {
  postId: number;
  imageOwnerId: number;
  userId: number;
}) {
  const rows = await dbRead.$queryRaw<{ managed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "Post" p
      JOIN "CollectionContributor" cc ON cc."collectionId" = p."collectionId"
      WHERE p.id = ${postId}
        AND p."userId" = ${imageOwnerId}
        AND cc."userId" = ${userId}
        AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    ) AS managed
  `);
  return rows[0]?.managed ?? false;
}
