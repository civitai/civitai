import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { getFileForModelVersion } from '~/server/services/file.service';
import { getFullTensorAnalysisCached } from '~/server/services/tensor-metadata.service';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import {
  inferTensorMetadataFormat,
  parseModelTensorMetadata,
  supportsTensorVramEstimate,
} from '~/utils/model-tensor-metadata';

/**
 * 🔴 `id` is bounded to a Postgres int4, and the bound is load-bearing — this is
 * the same defect `id-overflow-validation.test.ts` fixed for `models/[id]`.
 *
 * `z.number()` alone ACCEPTS `?id=1e30` and `?id=1.5`: `Number()` coerces both,
 * and neither an out-of-range float nor a non-integer is a `.number()` failure.
 * The value then binds to `ModelFile.id` (int4) and Postgres throws "value out of
 * range for type integer" / an invalid-input error from
 * `dbRead.modelFile.findUnique` — which sits BEFORE this handler's `try`, so the
 * throw escapes every civitai handler. A blind audit measured what that produces:
 * a bare `500 "Internal Server Error"` from Next's `apiResolver` with the driver
 * text absent, so it is NOT a disclosure. It is worse in a different way — there
 * is no `logToAxiom` on that path, so an anonymous caller can generate 500s that
 * leave NO structured fault record, which is exactly the forensic guarantee the
 * rest of civitai#3845 rests on.
 *
 * Bounding it here makes the bad input fail `safeParse` and take the handler's
 * EXISTING 400 arm, with `z.prettifyError` feedback. `buildTensorMetadataUrl`
 * only ever passes a real file id, so no legitimate caller is tightened out.
 */
const INT4_MAX = 2147483647;
const schema = z.object({
  id: z.preprocess((val) => Number(val), z.number().int().gt(0).lte(INT4_MAX)),
  summaryOnly: z.preprocess((val) => val === 'true' || val === true, z.boolean().optional()),
});
const TENSOR_METADATA_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';
const NO_STORE_CACHE_CONTROL = 'private, no-store';

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL);

  const result = schema.safeParse(req.query);
  if (!result.success)
    return res.status(400).json({ error: z.prettifyError(result.error) ?? 'Invalid file id' });

  const { id, summaryOnly } = result.data;
  const file = await dbRead.modelFile.findUnique({
    where: { id },
    select: {
      id: true,
      modelVersionId: true,
      name: true,
      type: true,
      sizeKB: true,
      metadata: true,
      modelVersion: { select: { model: { select: { type: true } } } },
    },
  });

  if (!file) return res.status(404).json({ error: 'File not found' });

  const fileResult = await getFileForModelVersion({
    modelVersionId: file.modelVersionId,
    fileId: id,
    user,
  });

  if (fileResult.status !== 'success') {
    const statusCode = getStatusCode(fileResult.status);
    return res.status(statusCode).json({ error: getErrorMessage(fileResult.status) });
  }

  const format = inferTensorMetadataFormat({
    name: file.name,
    metadata: file.metadata as BasicFileMetadata | null,
  });
  if (!format) return res.status(400).json({ error: 'File format is not supported' });

  // 🔴 The two lookups ABOVE are deliberately left outside this `try`, and that is
  // a decision rather than an oversight. Putting them inside would make a database
  // failure answer the 422 below, and that 422 is caller feedback ABOUT THE
  // REQUESTED FILE ("we could not read tensor metadata out of it") — a DB outage is
  // not that. Giving them their own `try` that delegates to `handleEndpointError`
  // was considered and rejected: the existing catch closes over `file` and `format`
  // for its `logToAxiom` call, so either shape requires hoisting both to `let` with
  // hand-written types and defeating TypeScript's narrowing across the boundary.
  // That is real bug surface on a hot public route, and the payoff is a log line on
  // a failure mode that is already a non-leaking hard 500 (measured). The
  // trivially-reachable instance — an out-of-range or non-integer `?id=` — is
  // closed at the schema instead, which is the cheap, deterministic half.
  // (`download/models` runs its identical preprocess INSIDE its try; the asymmetry
  // is real and recorded rather than silently equalised.)
  try {
    const estimateVram = supportsTensorVramEstimate({
      modelType: file.modelVersion.model.type,
      fileType: file.type,
    });

    // Tensor metadata is derived purely from immutable file content, so cache the parsed
    // analysis by file id. Auth is still re-checked per request above via getFileForModelVersion.
    //
    // Two separate caches, by access pattern:
    //  - FULL: the whole `analysis` incl. the ~335 KB `tensors[]` array. Highly
    //    compressible repetitive tensor-name strings, so stored brotli-compressed at rest
    //    (~65x). Only touched on accordion expand (!summaryOnly), or on a summary MISS.
    //  - SUMMARY: the tiny summary fields (~256 B) with `tensors` dropped. Fired on EVERY
    //    model-version view (the badge). A summary cache HIT must never read/decompress the
    //    big blob — it only falls through to the full fetch on a summary MISS.
    //
    // HOT-PATH DECODE GUARD: even with the summary/full split, a panel-open viewer hits
    // the FULL path on every model-page view, and the redis blob is brotli-compressed
    // (#2649) so each full read pays an async brotli-decompress + a SYNCHRONOUS ~335 KB
    // msgpack `unpack()` on the shared event loop. For a popular file that repeats per
    // request and concentrates into the api-primary 504 waves. `getFullTensorAnalysisCached`
    // wraps the redis-backed fetch in a bounded in-process LRU of the DECODED object, so a
    // hot model is decoded at most once per pod (the redis memory win is preserved — the
    // blob stays compressed+split in redis; we only remove the repeated hot-path decode).
    const fetchFull = () =>
      getFullTensorAnalysisCached(id, () =>
        fetchThroughCache(
          `${REDIS_KEYS.CACHES.TENSOR_METADATA}:${id}`,
          () =>
            parseModelTensorMetadata({
              url: fileResult.url,
              format,
              fileSizeBytes: file.sizeKB * 1024,
              estimateVram,
            }),
          // `cacheName` is the PREFIX, not the `${prefix}:${id}` key above — the codec
          // histogram's `cache_name` label has to stay bounded.
          { ttl: CacheTTL.month, compress: true, cacheName: REDIS_KEYS.CACHES.TENSOR_METADATA }
        )
      );

    if (summaryOnly) {
      const summary = await fetchThroughCache(
        `${REDIS_KEYS.CACHES.TENSOR_METADATA_SUMMARY}:${id}`,
        async () => {
          const analysis = await fetchFull();
          const { tensors, ...rest } = analysis;
          return rest;
        },
        { ttl: CacheTTL.month }
      );
      res.setHeader('Cache-Control', TENSOR_METADATA_CACHE_CONTROL);
      return res.status(200).json(summary);
    }

    const analysis = await fetchFull();
    res.setHeader('Cache-Control', TENSOR_METADATA_CACHE_CONTROL);
    res.status(200).json(analysis);
  } catch (error) {
    // The upstream byte-range fetch fails transiently. If this 422 ever inherits the immutable
    // header, Cloudflare freezes the error for a year and the file's panel never recovers.
    res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL);

    const err = error instanceof Error ? error : new Error(String(error));
    logToAxiom({
      name: 'model-file-tensor-metadata',
      type: 'error',
      message: err.message,
      stack: err.stack,
      fileId: id,
      modelVersionId: file.modelVersionId,
      format,
    }).catch(() => undefined);

    // 🔴 civitai#3845 TIER 1. This was `{ error: err.message }` on a
    // `MixedAuthEndpoint` whose read path is public, so an anonymous caller got
    // whatever failed inside the try verbatim — including a driver's
    // ``Invalid `prisma.…` invocation`` from the cache-miss read path.
    //
    // The STATUS is kept and NOT delegated to `handleEndpointError`. 422 here is a
    // statement about the requested FILE ("we could not read tensor metadata out of
    // it"), which is caller feedback; delegating would reclassify it as a 500,
    // because nothing in this try throws a TRPCError. The zod rejection of `?id=`
    // is already a separate `safeParse` 400 at the top of the handler and never
    // enters this catch, so no validation path changes here at all.
    //
    // Only the MESSAGE is replaced, and with a string LITERAL rather than an
    // imported constant on purpose: `ModelTensorMetadata.tsx` renders `body.error`
    // directly as the panel's error text, so it must stay a non-empty string a
    // human can read. The un-redacted message and stack are already in the
    // `logToAxiom` call directly above — nothing is destroyed, only moved.
    return res.status(422).json({ error: 'Unable to read tensor metadata for this file' });
  }
});

function getStatusCode(
  status: Exclude<Awaited<ReturnType<typeof getFileForModelVersion>>['status'], 'success'>
) {
  switch (status) {
    case 'unauthorized':
    case 'no-access':
    case 'downloads-disabled':
    case 'early-access':
      return 403;
    case 'archived':
      return 410;
    case 'not-found':
    case 'resolve-failed':
      return 404;
    default:
      return 500;
  }
}

function getErrorMessage(
  status: Exclude<Awaited<ReturnType<typeof getFileForModelVersion>>['status'], 'success'>
) {
  switch (status) {
    case 'unauthorized':
      return 'Unauthorized';
    case 'no-access':
      return 'You do not have access to this file';
    case 'downloads-disabled':
      return 'Downloads are disabled for this file';
    case 'early-access':
      return 'File is in early access';
    case 'archived':
      return 'Model archived, not available';
    case 'not-found':
    case 'resolve-failed':
      return 'File not found';
    default:
      return 'Error getting file';
  }
}
