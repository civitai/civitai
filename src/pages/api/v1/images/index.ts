import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import client from 'prom-client';
import { buildFliptContext, getFeatureFlags } from '~/server/services/feature-flags.service';
import { ensureRegisterFeedImageExistenceCheckMetrics } from '~/server/metrics/feed-image-existence-check.metrics';
import {
  buildSearchActor,
  isFailfastStatus,
  MeiliCallTimeoutError,
  MeilisearchFetchError,
} from '~/server/meilisearch/client';
import {
  getAllImages,
  getAllImagesIndex,
  getImagesFromFeedSearch,
} from '~/server/services/image.service';
import { imageMetaCache } from '~/server/redis/caches';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { longTaskLabelsArmed, runWithLongTaskLabel } from '~/server/eventloop-longtask';
import {
  acquireBulkheadSlot,
  BulkheadFullError,
  HEAVY_REQUEST_CONCURRENCY,
} from '~/server/utils/request-bulkhead';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getPagination } from '~/server/utils/pagination-helpers';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { baseModels } from '~/shared/constants/basemodel.constants';
import {
  getNsfwLevelDeprecatedReverseMapping,
  nsfwBrowsingLevelsFlag,
  NsfwLevelDeprecated,
  nsfwLevelMapDeprecated,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';
import {
  booleanString,
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';
import { usernameSchema } from '~/shared/zod/username.schema';

export const config = {
  api: {
    responseLimit: false,
  },
};

// TODO merge with getInfiniteImagesSchema
const imagesEndpointSchema = z.object({
  limit: numericString(z.number().min(0).max(200)).default(constants.galleryFilterDefaults.limit),
  page: numericString().optional(),
  postId: numericString().optional(),
  modelId: numericString().optional(),
  modelVersionId: numericString().optional(),
  imageId: numericString().optional(),
  username: usernameSchema.optional(),
  userId: numericString().optional(),
  period: z.enum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.enum(ImageSort).default(constants.galleryFilterDefaults.sort),
  nsfw: z
    .union([z.enum(NsfwLevelDeprecated), booleanString()])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      if (typeof value === 'boolean')
        return value ? nsfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
      return nsfwLevelMapDeprecated[value] as number;
    }),
  browsingLevel: z.coerce.number().optional(),
  tags: commaDelimitedNumberArray().optional(),
  cursor: z
    .union([z.bigint(), z.number(), z.string(), z.date()])
    .transform((val) =>
      typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
        ? new Date(val)
        : val
    )
    .optional(),
  type: z.enum(MediaType).optional(),
  baseModels: commaDelimitedEnumArray([...baseModels]).optional(),
  withMeta: booleanString().default(false),
  requiringMeta: booleanString().optional(),
  flatMeta: booleanString().optional(),
  withTags: booleanString().default(false),
});

// Reuse the shared images-search metrics bundle (idempotent registration on the
// default registry that /api/metrics scrapes). This times the FULL REST handler
// — including enrichment + JSON serialization, the actual pin cost — which the
// inner getImagesFromSearch timer doesn't capture. route label keeps it queryable
// alongside the search-fn timing without extra cardinality.
const { requestDurationSeconds } = ensureRegisterFeedImageExistenceCheckMetrics(client.register);

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // When the long-task LABELS tier is armed, attribute any synchronous event-loop
  // block during this heavy handler to 'rest:/api/v1/images'. That costs one
  // AsyncLocalStorage.run() per request and is OFF by default. When it is not
  // armed (the disarmed default AND base-armed-without-labels), this is the
  // ORIGINAL code path: a direct handler call with NO wrapper/closure. See
  // src/server/eventloop-longtask.ts.
  if (longTaskLabelsArmed) {
    return runWithLongTaskLabel('rest:/api/v1/images', () => handleImagesRequest(req, res));
  }
  return handleImagesRequest(req, res);
});

async function handleImagesRequest(req: NextApiRequest, res: NextApiResponse) {
  // Started AFTER param validation + the paging guard so cheap 400/429 rejects
  // aren't recorded as ~0ms heavy requests, which would dilute the heavy-tail P99
  // this metric exists to measure. (Also the correct slot for the bulkhead merge:
  // the #2428 acquire goes immediately above this, so a 503-rejected request is
  // never timed.) Ended in finally; `?.` because early returns leave it unstarted.
  let endTimer: (() => void) | undefined;

  let releaseSlot: (() => void) | undefined;
  try {
    const reqParams = imagesEndpointSchema.safeParse(req.query);
    if (!reqParams.success) return res.status(400).json({ error: reqParams.error });

    const session = await getServerAuthSession({ req, res });

    // Handle pagination
    const { limit, page, cursor, nsfw, browsingLevel, type, withMeta, flatMeta, withTags, ...data } =
      reqParams.data;
    let skip: number | undefined;
    const usingPaging = page && !cursor;
    if (usingPaging) {
      if (page && page * limit > 1000) {
        // Enforce new paging limit
        return res
          .status(429)
          .json({ error: "You've requested too many pages, please use cursors instead" });
      }

      ({ skip } = getPagination(limit, page));
    }

    // Per-pod concurrency cap (shared with the tRPC feed via the 'heavy-image' key):
    // fast-fail with 503 when this pod is already saturated with heavy image work,
    // so a backlog can't pin the single JS thread → probe timeout → Error/137.
    // Acquired AFTER param validation + the paging guard so cheap 400/429 rejects
    // don't consume a heavy slot. no-store so an edge layer can't cache the 503
    // and turn a momentary shed into a multi-minute outage. Released in the finally
    // below — NOT on res 'close', which can lag the actual heavy work by the
    // keep-alive teardown and would hold the slot (and shed) long after the JS
    // thread is free. Symmetric with the tRPC heavyProcedure's finally release.
    try {
      releaseSlot = acquireBulkheadSlot('heavy-image', HEAVY_REQUEST_CONCURRENCY);
    } catch (e) {
      if (e instanceof BulkheadFullError) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        return res.status(503).json({ error: 'Server busy, please retry shortly.' });
      }
      throw e;
    }

    // Timed only for admitted requests (bulkhead 503 returns above, before this).
    endTimer = requestDurationSeconds.startTimer({ route: 'api/v1/images' });

    // Check if request is from restricted region and override browsing level
    const region = getRegion(req);
    let _browsingLevel = browsingLevel ?? nsfw ?? publicBrowsingLevelsFlag;
    if (isRegionRestricted(region)) _browsingLevel = sfwBrowsingLevelsFlag;

    const features = getFeatureFlags({ user: session?.user, req });

    // Check BitDex mode — if active, route through getAllImagesIndex
    const bitdexMode = await getFliptVariant(
      FLIPT_FEATURE_FLAGS.BITDEX_IMAGE_SEARCH,
      session?.user?.id?.toString() || 'anonymous',
      buildFliptContext(session?.user)
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
    const useLegacyMethod = data.imageId || (data.modelId && !data.modelVersionId);

    const actor = buildSearchActor({
      userId: session?.user?.id,
      ip: requestIp.getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

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
          browsingLevel: _browsingLevel,
          withMeta: false,
          user: session?.user,
          disableMinor: true,
          disablePoi: true,
          includeBaseModel: true,
          dbTarget: features.datapacketRead ? 'datapacket' : 'read',
        })
      : useBitdex
      ? await getAllImagesIndex({
          ...data,
          types: type ? [type] : undefined,
          limit,
          skip,
          cursor,
          include: ['tagIds', 'profilePictures', ...(withTags ? ['tags' as const] : [])],
          periodMode: 'published',
          browsingLevel: _browsingLevel,
          withMeta: false,
          user: session?.user,
          useCombinedNsfwLevel: !features.canViewNsfw,
          disableMinor: true,
          disablePoi: true,
          headers: { src: '/api/v1/images' },
          dbTarget: features.datapacketRead ? 'datapacket' : 'read',
          actor,
        })
      : await getImagesFromFeedSearch({
          ...data,
          types: type ? [type] : undefined,
          limit,
          skip,
          cursor,
          include: ['tagIds', 'profilePictures', ...(withTags ? ['tags' as const] : [])],
          periodMode: 'published',
          browsingLevel: _browsingLevel,
          withMeta: false,
          currentUserId: session?.user?.id,
          isModerator: session?.user?.isModerator,
          useCombinedNsfwLevel: !features.canViewNsfw,
          disableMinor: true,
          disablePoi: true,
          actor,
        });

    let imageMetas: Record<number, { id: number; meta?: any }> = {};
    if (withMeta && items.length > 0) {
      imageMetas = await imageMetaCache.fetch(items.map((img) => img.id));
    }

    const metadata: Metadata = {
      nextCursor,
    };

    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }
    metadata.nextPage = getNextPage({ req, ...metadata });

    res.status(200).json({
      items: items.map((image) => {
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
      }),
      metadata,
    });
  } catch (error) {
    if (isClientAbortError(error)) {
      // Client disconnected mid-feed (closed tab / scrolled past / navigated). The
      // Meili fetch's AbortSignal fired and bubbled a bare AbortError — not a server
      // fault. 499 keeps it out of the 5xx SLO + the http-errors counter. (Was the
      // top mislabeled-500 source on this endpoint.)
      if (!res.headersSent) res.status(499).end();
      return;
    }
    // Meili saturation / timeout / upstream 5xx (feeds-proxy shed or backend
    // brownout) → 503 SERVICE_UNAVAILABLE, retryable. Without this the raw
    // MeiliCallTimeoutError / MeilisearchFetchError is not a TRPCError, so the
    // generic mapping below defaults it to 500 — the dominant mislabeled-500
    // source on this endpoint. no-store so an edge layer can't cache the error,
    // Retry-After so clients/CF retry the (typically seconds-long) flap.
    // Mirrors the tRPC image feed + the /api/v1/models handler. 4xx-other
    // (malformed filter / auth) is NOT failfast-eligible and still bubbles to
    // the generic mapping below.
    if (
      error instanceof MeiliCallTimeoutError ||
      (error instanceof MeilisearchFetchError && isFailfastStatus(error.status))
    ) {
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        res
          .status(503)
          .json({ error: 'Image search is temporarily overloaded — please retry.' });
      }
      return;
    }
    const trpcError = error as TRPCError;
    const statusCode = getHTTPStatusCodeFromError(trpcError);

    return res.status(statusCode).json({
      error: trpcError.message,
      code: trpcError.code,
    });
  } finally {
    endTimer?.();
    // Release the heavy slot as soon as the handler resolves (synchronous
    // serialization — the actual pin cost — is done by now), not on socket close.
    releaseSlot?.();
  }
}

type Metadata = {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: string;
  nextPage?: string;
};

function getNextPage({
  req,
  currentPage,
  nextCursor,
}: {
  req: NextApiRequest;
  nextCursor?: string;
  currentPage?: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd && req.headers.host ? `https://${req.headers.host}` : 'http://localhost:3000'
  );

  const hasNextPage = !!nextCursor;
  if (!hasNextPage) return undefined;

  const queryParams: Record<string, any> = { ...req.query };
  if (currentPage) queryParams.page = currentPage + 1;
  else queryParams.cursor = nextCursor;

  return `${baseUrl.origin}${baseUrl.pathname}?${QS.stringify(queryParams)}`;
}
