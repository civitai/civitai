import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';
import requestIp from 'request-ip';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { buildFliptContext, getFeatureFlags } from '~/server/services/feature-flags.service';
import { buildSearchActor } from '~/server/meilisearch/client';
import {
  getAllImages,
  getAllImagesIndex,
  getImagesFromFeedSearch,
} from '~/server/services/image.service';
import { imageMetaCache } from '~/server/redis/caches';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import {
  getNsfwLevelDeprecatedReverseMapping,
  NsfwLevelDeprecated,
} from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Shared image-search + response-shaping body extracted verbatim from
 * `/api/v1/images/index.ts` so the public endpoint AND the block-scoped catalog
 * endpoint (`/api/v1/blocks/images.ts`) build the SAME response from the SAME
 * query path (legacy `getAllImages` / BitDex `getAllImagesIndex` / feed
 * `getImagesFromFeedSearch`, the `withMeta` enrichment, and the JSON shaping).
 *
 * The ONLY maturity lever is `browsingLevel`, supplied by the caller. The public
 * endpoint passes its existing region/`?nsfw=`-derived value UNCHANGED; the
 * block endpoint passes a value already CLAMPED to the token's domain ceiling.
 * There is NO `nsfw`-passthrough widening for images: the public endpoint maps
 * `?nsfw=` into `browsingLevel` BEFORE this helper runs (unlike models, where a
 * separate per-image `nsfw` flag widened the image list), so the per-image
 * `nsfwLevel` filter that `getAllImages*`/feed-search apply is driven SOLELY by
 * `browsingLevel`. A SFW-clamped block can therefore never surface a mature
 * image — no separate passthrough exists to re-widen it.
 *
 * Maturity policy is NOT decided here — this helper is a pure executor. The
 * caller is the single place that derives the effective `browsingLevel`.
 */

// The validated params an image search needs, minus the maturity knobs (`nsfw`
// / `browsingLevel`) which the caller resolves into the single `browsingLevel`
// context field, and minus `page`/`limit`/`cursor` which are passed explicitly.
export type RunImageSearchInput = {
  /** Per-page take (the validated `limit`). */
  limit: number;
  /** Offset-paging skip (public endpoint only; undefined for cursor paths). */
  skip?: number;
  /** Cursor — bigint|number|string|Date, matching the public endpoint's parsed union. */
  cursor?: bigint | number | string | Date;
  /** MediaType filter (the public endpoint's `type`, forwarded as `types: [type]`). */
  type?: MediaType;
  withMeta: boolean;
  flatMeta?: boolean;
  withTags: boolean;
  /** The remaining `...data` fields off the parsed schema (postId/modelId/username/etc). */
  data: Record<string, unknown>;
};

export type RunImageSearchContext = {
  /**
   * The EFFECTIVE browsing-level flag. The caller is the single source of
   * truth: the public endpoint passes its region/nsfw-derived value; the block
   * endpoint passes a value already clamped to the token's domain ceiling.
   */
  browsingLevel: number;
  /** The viewer (session user) — undefined for anon. */
  user?: SessionUser;
  /** Used for feature flags, region read by the caller, and the BitDex/search actor. */
  req: NextApiRequest;
};

export type ShapedImage = {
  id: number;
  url: string;
  hash: unknown;
  width: unknown;
  height: unknown;
  nsfwLevel: NsfwLevelDeprecated;
  type: unknown;
  nsfw: boolean;
  browsingLevel: number;
  createdAt: unknown;
  postId: unknown;
  stats: {
    cryCount: number;
    laughCount: number;
    likeCount: number;
    dislikeCount: number;
    heartCount: number;
    commentCount: number;
  };
  meta: unknown;
  username: unknown;
  baseModel: unknown;
  modelVersionIds: unknown;
  tags?: Array<{ id: number; name: string }>;
};

/**
 * Run the image search and shape the response. Behavior-preserving extraction
 * of the body of `/api/v1/images/index.ts`. The caller owns: param parsing,
 * pagination math, the bulkhead slot, the REST timer, the region clamp, and —
 * critically — the EFFECTIVE `browsingLevel`. This function decides no policy.
 */
export async function runImageSearch(
  input: RunImageSearchInput,
  ctx: RunImageSearchContext
): Promise<{ items: ShapedImage[]; nextCursor?: string }> {
  const { browsingLevel, user, req } = ctx;
  const { limit, skip, cursor, type, withMeta, flatMeta, withTags, data } = input;

  const features = getFeatureFlags({ user, req });

  // Check BitDex mode — if active, route through getAllImagesIndex
  const bitdexMode = await getFliptVariant(
    FLIPT_FEATURE_FLAGS.BITDEX_IMAGE_SEARCH,
    user?.id?.toString() || 'anonymous',
    buildFliptContext(user)
  );
  const useBitdex = bitdexMode === 'shadow' || bitdexMode === 'primary';

  // Always route modelId/imageId lookups through legacy getAllImages — BitDex
  // and Meili feed search don't support filtering by modelId/imageId (they index
  // postedToId/modelVersionId only), so they'd silently return the global feed.
  // When both modelId and modelVersionId are passed, modelId is redundant
  // (getAllImages also silently ignores it via an `else if` chain) — let those
  // requests flow through the search index so engagement sorts
  // (MostReactions/MostComments/MostCollected) work, since getAllImages's gallery
  // sort branches for those are currently disabled. Fixes #2134.
  //
  // KNOWN LIMITATION: when only `modelId` is passed (no `modelVersionId`), the
  // legacy DB path is the only option, and its MostReactions/MostComments/
  // MostCollected branches are intentionally commented out at
  // image.service.ts:1414-1422 with a `// TODO this causes the app to spike`
  // note. As a result, those sorts collapse to newest-by-id for `modelId`-only
  // queries. Callers that need engagement-sorted galleries should also pass a
  // specific `modelVersionId`, which routes through the search index where
  // those sorts are honored.
  const useLegacyMethod = (data as { imageId?: unknown }).imageId
    ? true
    : !!(data as { modelId?: unknown }).modelId && !(data as { modelVersionId?: unknown }).modelVersionId;

  const actor = buildSearchActor({
    userId: user?.id,
    ip: requestIp.getClientIp(req),
    userAgent: req.headers['user-agent'],
  });

  // Cast through `unknown` at this single seam: the caller supplies `data` as
  // the parsed schema's `...data` rest (the public endpoint a full parsed value
  // carrying schema defaults like period/sort; the block endpoint the same
  // selector rest), but the static type erases those keys to a Record. The
  // runtime contract is identical to the pre-refactor endpoint — period/sort
  // are always present in `data` since the destructure only pulls out
  // limit/page/cursor/maturity/type/meta flags. The image service reads them at
  // runtime, so this is byte-equivalent to the original inline call.
  const { items, nextCursor } = useLegacyMethod
    ? await getAllImages({
        ...data,
        types: type ? [type] : undefined,
        limit,
        skip,
        cursor,
        // Only fetch tagIds and profilePictures here; metaSelect is fetched
        // on-demand in the controller below to avoid query filtering.
        include: ['tagIds', 'profilePictures', ...(withTags ? ['tags' as const] : [])],
        periodMode: 'published',
        headers: { src: '/api/v1/images' },
        browsingLevel,
        withMeta: false,
        user,
        disableMinor: true,
        disablePoi: true,
        includeBaseModel: true,
        dbTarget: features.datapacketRead ? 'datapacket' : 'read',
      } as unknown as Parameters<typeof getAllImages>[0])
    : useBitdex
    ? await getAllImagesIndex({
        ...data,
        types: type ? [type] : undefined,
        limit,
        skip,
        cursor,
        include: ['tagIds', 'profilePictures', ...(withTags ? ['tags' as const] : [])],
        periodMode: 'published',
        browsingLevel,
        withMeta: false,
        user,
        useCombinedNsfwLevel: !features.canViewNsfw,
        disableMinor: true,
        disablePoi: true,
        headers: { src: '/api/v1/images' },
        dbTarget: features.datapacketRead ? 'datapacket' : 'read',
        actor,
      } as unknown as Parameters<typeof getAllImagesIndex>[0])
    : await getImagesFromFeedSearch({
        ...data,
        types: type ? [type] : undefined,
        limit,
        skip,
        cursor,
        include: ['tagIds', 'profilePictures', ...(withTags ? ['tags' as const] : [])],
        periodMode: 'published',
        browsingLevel,
        withMeta: false,
        currentUserId: user?.id,
        isModerator: user?.isModerator,
        useCombinedNsfwLevel: !features.canViewNsfw,
        disableMinor: true,
        disablePoi: true,
        actor,
      } as unknown as Parameters<typeof getImagesFromFeedSearch>[0]);

  let imageMetas: Record<number, { id: number; meta?: any }> = {};
  if (withMeta && items.length > 0) {
    imageMetas = await imageMetaCache.fetch(items.map((img) => img.id));
  }

  const shaped: ShapedImage[] = items.map((image) => {
    const nsfw = getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel);

    return {
      id: image.id,
      url: getEdgeUrl(image.url, { original: true, type: image.type }),
      hash: image.hash,
      width: image.width,
      height: image.height,
      nsfwLevel: nsfw,
      type: image.type,
      nsfw: nsfw !== NsfwLevelDeprecated.None,
      browsingLevel: image.nsfwLevel,
      createdAt: image.createdAt,
      postId: image.postId,
      stats: {
        cryCount: image.stats?.cryCountAllTime ?? 0,
        laughCount: image.stats?.laughCountAllTime ?? 0,
        likeCount: image.stats?.likeCountAllTime ?? 0,
        dislikeCount: image.stats?.dislikeCountAllTime ?? 0,
        heartCount: image.stats?.heartCountAllTime ?? 0,
        commentCount: image.stats?.commentCountAllTime ?? 0,
      },
      meta: (() => {
        if (!withMeta) return null;
        const imageMeta = imageMetas[image.id]?.meta ?? null;
        const useFlat = flatMeta !== undefined ? flatMeta : !useLegacyMethod;
        return useFlat ? imageMeta : { id: image.id, meta: imageMeta };
      })(),
      username: image.user.username,
      baseModel: image.baseModel,
      modelVersionIds: image.modelVersionIds,
      tags: withTags ? (image.tags?.map((t) => ({ id: t.id, name: t.name })) ?? []) : undefined,
    };
  });

  return { items: shaped, nextCursor };
}
