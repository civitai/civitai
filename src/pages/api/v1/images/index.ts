import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isProd } from '~/env/other';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import client from 'prom-client';
import { ensureRegisterFeedImageExistenceCheckMetrics } from '~/server/metrics/feed-image-existence-check.metrics';
import { isTransientMeiliError } from '~/server/meilisearch/client';
import { runImageSearch } from '~/server/services/image-search.service';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
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

    // Search + response shaping is shared with /api/v1/blocks/images via
    // runImageSearch. The PUBLIC endpoint passes its existing region/nsfw-derived
    // browsingLevel UNCHANGED (mapped above from ?nsfw=/?browsingLevel=); the
    // block endpoint passes a server-clamped value. No other lever differs.
    const { items, nextCursor } = await runImageSearch(
      { limit, skip, cursor, type, withMeta, flatMeta, withTags, data },
      { browsingLevel: _browsingLevel, user: session?.user, req }
    );

    const metadata: Metadata = {
      nextCursor,
    };

    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }
    metadata.nextPage = getNextPage({ req, ...metadata });

    res.status(200).json({
      items,
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
    // Meili saturation / timeout / upstream 408/429/5xx (feeds-proxy shed or
    // backend brownout) → 503 SERVICE_UNAVAILABLE, retryable. `isTransientMeiliError`
    // matches BOTH civitai's own wrapper errors (MeiliCallTimeoutError /
    // MeilisearchFetchError) AND the meilisearch-js SDK's own error types
    // (MeiliSearchCommunicationError / MeiliSearchApiError / MeiliSearchTimeOutError)
    // that the feed library's inner SDK calls throw — none of which are
    // TRPCErrors, so the generic mapping below would otherwise default them to
    // 500. Those SDK errors (a 408 "Request Timeout" / 503 "Service Unavailable"
    // from the proxy) were the dominant mislabeled-500 source on this endpoint.
    // The service layer (getImagesFromFeedSearch / getAllImagesIndex) now wraps
    // them as TRPCError SERVICE_UNAVAILABLE before they reach here, but this
    // branch is kept as defense-in-depth (a raw SDK error escaping the wrap
    // still becomes 503-with-headers, not a hard 500). no-store so an edge
    // layer can't cache the error; Retry-After so clients/CF retry the
    // (typically seconds-long) flap. 4xx-other (malformed filter / auth) is NOT
    // transient and still bubbles to the generic mapping below.
    //
    // 🔴 BOTH transient shapes — the raw SDK error and the service layer's
    // `TRPCError SERVICE_UNAVAILABLE` wrap of it — are answered HERE, in place,
    // with ONE body. An earlier draft of this change set the headers for the
    // TRPCError case and then fell through to `handleEndpointError`, which
    // answers a 503 as `{ message }`. That left the SAME ROUTE emitting the retry
    // hint under `error` on this path and under `message` on that one, so no
    // client could read a single key to get it at 503 — strictly worse than
    // either choice alone. This is the shape `/api/v1/users` uses, and the two
    // 503 paths on this route are now byte-identical.
    //
    // Answering in place also keeps the hint OUT of the helper's 503 pass-through,
    // which is deliberately NOT genericized (it is the only copy of a retry hint).
    // A literal here means a `TRPCError` whose message happens to be
    // driver-authored cannot reach the wire through this branch at all.
    const trpcStatus = error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : undefined;
    if (isTransientMeiliError(error) || trpcStatus === 503) {
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        res.status(503).json({ error: 'Image search is temporarily overloaded — please retry.' });
      }
      return;
    }

    // 🔴 civitai#3845 TIER 1. This was `{ error: trpcError.message, code: trpcError.code }`
    // on a `PublicEndpoint` — i.e. served to ANONYMOUS callers. `trpcError` is
    // whatever escaped `runImageSearch`, and a `throwDbError`-wrapped driver error
    // puts a raw ``Invalid `prisma.image.findMany()` invocation`` — table and column
    // names — straight on the wire. Nothing above this line is a validation
    // rejection: the zod `safeParse` 400 and the paging 429 both `return` from the
    // try body and never enter this catch, so delegating here cannot turn a client's
    // malformed `?limit=` into a 500. A 4xx TRPCError from the search layer keeps
    // its status; only a 5xx (and a driver-authored 4xx) is genericized, and the
    // un-redacted text goes to the fault log instead of to the caller.
    //
    // The 4xx body shape changes from `{ error, code }` to `{ message }` — the same
    // trade `/api/v1/users` made in the parent change, and the shared shape is the
    // point of consolidating. 503 does NOT reach here: it is answered above, in its
    // original shape.
    return handleEndpointError(res, error);
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
