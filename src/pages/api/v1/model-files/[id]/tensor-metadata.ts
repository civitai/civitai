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

const schema = z.object({
  id: z.preprocess((val) => Number(val), z.number()),
  summaryOnly: z.preprocess((val) => val === 'true' || val === true, z.boolean().optional()),
});
const TENSOR_METADATA_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  res.setHeader('Cache-Control', 'private, no-store');

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
          { ttl: CacheTTL.month, compress: true }
        )
      );

    res.setHeader('Cache-Control', TENSOR_METADATA_CACHE_CONTROL);

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
      return res.status(200).json(summary);
    }

    const analysis = await fetchFull();
    res.status(200).json(analysis);
  } catch (error) {
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

    return res.status(422).json({ error: err.message });
  }
});

function getStatusCode(
  status: Exclude<Awaited<ReturnType<typeof getFileForModelVersion>>['status'], 'success'>
) {
  switch (status) {
    case 'unauthorized':
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
