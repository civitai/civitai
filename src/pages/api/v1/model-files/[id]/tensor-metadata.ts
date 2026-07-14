import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { getFileForModelVersion } from '~/server/services/file.service';
import { persistModelTensorHeaderMetadata } from '~/server/services/tensor-metadata-persistence.service';
import { getFullTensorAnalysisCached } from '~/server/services/tensor-metadata.service';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import {
  detectModelTypeFromTensors,
  getDominantWeightPrecision,
  getModelFileTypeCorrection,
  inferTensorMetadataFormat,
  parseModelTensorMetadata,
  supportsTensorVramEstimate,
  type ModelTensorAnalysis,
  weightPrecisionToModelFileFp,
} from '~/utils/model-tensor-metadata';

const schema = z.object({
  id: z.preprocess((val) => Number(val), z.number()),
  summaryOnly: z.preprocess((val) => val === 'true' || val === true, z.boolean().optional()),
});
const TENSOR_METADATA_CACHE_CONTROL = 'public, max-age=31536000, s-maxage=31536000, immutable';
// Version the small summary independently so existing full tensor caches can be
// enriched without another model-host range request.
const TENSOR_METADATA_SUMMARY_VERSION = 2;

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
      url: true,
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
    const currentMetadata = file.metadata as BasicFileMetadata | null;
    const addDerivedMetadata = <
      T extends Pick<ModelTensorAnalysis, 'dtypeCounts'> &
        Partial<Pick<ModelTensorAnalysis, 'weightPrecision' | 'detectedModelType' | 'tensors'>>
    >(
      data: T
    ) => {
      // Cached analyses can contain older derived values. Recompute whenever the
      // underlying dtype totals or tensor names are available.
      const weightPrecision = getDominantWeightPrecision(data.dtypeCounts);
      const detectedModelType =
        format === 'SafeTensor'
          ? data.tensors
            ? detectModelTypeFromTensors(data.tensors)
            : data.detectedModelType ?? null
          : null;
      return { ...data, weightPrecision, detectedModelType };
    };
    const persistDerivedMetadata = async <
      T extends Pick<ModelTensorAnalysis, 'dtypeCounts'> &
        Partial<Pick<ModelTensorAnalysis, 'weightPrecision' | 'detectedModelType' | 'tensors'>>
    >(
      data: T
    ) => {
      const enriched = addDerivedMetadata(data);
      const fp =
        format === 'SafeTensor' ? weightPrecisionToModelFileFp(enriched.weightPrecision) : null;
      const correctedFileType =
        format === 'SafeTensor'
          ? getModelFileTypeCorrection({
              detectedModelType: enriched.detectedModelType,
              modelType: file.modelVersion.model.type,
              currentFileType: file.type,
            })
          : null;

      await persistModelTensorHeaderMetadata({
        fileId: file.id,
        fileUrl: file.url,
        modelVersionId: file.modelVersionId,
        currentWeightPrecision: currentMetadata?.weightPrecision,
        weightPrecision: enriched.weightPrecision,
        currentFp: currentMetadata?.fp,
        fp,
        currentFileType: file.type,
        correctedFileType,
      });
      return enriched;
    };

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
    const fetchFull = async () =>
      addDerivedMetadata(
        await getFullTensorAnalysisCached(id, () =>
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
        )
      );

    if (summaryOnly) {
      const summary = await fetchThroughCache(
        `${REDIS_KEYS.CACHES.TENSOR_METADATA_SUMMARY}:${TENSOR_METADATA_SUMMARY_VERSION}:${id}`,
        async () => {
          const analysis = await fetchFull();
          const { tensors, ...rest } = analysis;
          return rest;
        },
        { ttl: CacheTTL.month }
      );
      const response = await persistDerivedMetadata(summary);
      res.setHeader('Cache-Control', TENSOR_METADATA_CACHE_CONTROL);
      return res.status(200).json(response);
    }

    const analysis = await fetchFull();
    const response = await persistDerivedMetadata(analysis);
    res.setHeader('Cache-Control', TENSOR_METADATA_CACHE_CONTROL);
    res.status(200).json(response);
  } catch (error) {
    res.setHeader('Cache-Control', 'private, no-store');
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
