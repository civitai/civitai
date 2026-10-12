import type { Context } from '~/server/createContext';
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

/**
 * Whether a single-image response may carry the media itself. Mirrors when `Gated` renders the
 * page: the domain cap for the request, with the owner and moderators always allowed.
 */
export function canViewImageMedia(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  image: Pick<MediaFields, 'nsfwLevel' | 'user'>
) {
  if (ctx.user && (ctx.user.isModerator || ctx.user.id === image.user.id)) return true;
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
  image: T
): Omit<T, 'url'> & { url: string | null } {
  if (canViewImageMedia(ctx, image)) {
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
