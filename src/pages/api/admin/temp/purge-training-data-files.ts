import type { S3Client } from '@aws-sdk/client-s3';
import { DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getB2S3Client,
  getS3Client,
  headObject,
  resolveModelFileDeleteTarget,
  urlsSafeToDelete,
} from '~/utils/s3-utils';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Permanently removes the Training Data files of the given model versions: every stored version
 * of each object, then the ModelFile row.
 *
 * GET /api/admin/temp/purge-training-data-files?token=<WEBHOOK_TOKEN>&modelVersionIds=1,2,3
 *   &dryRun=true|false   (default true) reports what would be removed and removes nothing
 *
 * Only Training Data files of trained versions whose model is already deleted are touched.
 */

const schema = z.object({
  modelVersionIds: z
    .string()
    .transform((s) => s.split(',').map((v) => Number(v.trim())))
    .pipe(z.array(z.number().int().positive()).min(1).max(20)),
  dryRun: booleanString().default(true),
});

type StoredVersion = { versionId: string | undefined; isDeleteMarker: boolean; size?: number };

// A delete without a VersionId on a versioned bucket (B2 keeps every version by default) only
// writes a hide marker and leaves the bytes, so every version and marker is deleted by id.
async function listStoredVersions(s3: S3Client, bucket: string, key: string) {
  const found: StoredVersion[] = [];
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker })
    );
    for (const v of res.Versions ?? [])
      if (v.Key === key)
        found.push({ versionId: v.VersionId, isDeleteMarker: false, size: v.Size });
    for (const m of res.DeleteMarkers ?? [])
      if (m.Key === key) found.push({ versionId: m.VersionId, isDeleteMarker: true });
    if (!res.IsTruncated) return found;
    KeyMarker = res.NextKeyMarker;
    VersionIdMarker = res.NextVersionIdMarker;
  }
  throw new Error('Version listing did not terminate');
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { modelVersionIds, dryRun } = parsed.data;

  const files = await dbWrite.modelFile.findMany({
    where: { modelVersionId: { in: modelVersionIds }, type: 'Training Data' },
    select: {
      id: true,
      url: true,
      modelVersionId: true,
      modelVersion: {
        select: { uploadType: true, model: { select: { deletedAt: true } } },
      },
    },
  });

  const results = [];
  for (const file of files) {
    const result: Record<string, unknown> = {
      fileId: file.id,
      modelVersionId: file.modelVersionId,
    };
    results.push(result);

    if (file.modelVersion.uploadType !== 'Trained' || !file.modelVersion.model.deletedAt) {
      result.skipped = 'model-not-deleted-or-not-trained';
      continue;
    }
    const target = resolveModelFileDeleteTarget(file.url);
    if (!target.ok) {
      result.skipped = target.reason;
      continue;
    }
    const { safe } = await urlsSafeToDelete([file.url], file.id);
    if (safe.length === 0) {
      result.skipped = 'still-referenced';
      continue;
    }

    const s3 = target.backend === 'b2' ? getB2S3Client() : getS3Client();
    result.bucket = target.bucket;
    result.key = target.key;
    try {
      const before = await listStoredVersions(s3, target.bucket, target.key);
      result.storedVersionsBefore = before;
      result.headBefore = (await headObject(target.bucket, target.key, s3)).status;
      if (dryRun) continue;
      if (before.some((v) => !v.versionId)) {
        result.error = 'a stored version has no id; nothing deleted';
        continue;
      }

      for (const v of before)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: target.bucket,
            Key: target.key,
            VersionId: v.versionId,
          })
        );

      const after = await listStoredVersions(s3, target.bucket, target.key);
      const head = await headObject(target.bucket, target.key, s3);
      result.storedVersionsAfter = after;
      result.headAfter = head.status;
      if (after.length > 0 || head.status !== 'absent') {
        result.error = 'object still present after delete; row kept';
        continue;
      }

      await dbWrite.modelFile.delete({ where: { id: file.id } });
      result.rowDeleted = true;
    } catch (e) {
      result.error = (e as Error).message;
    }
  }

  const foundVersionIds = new Set(files.map((f) => f.modelVersionId));
  res.status(200).json({
    dryRun,
    noTrainingData: modelVersionIds.filter((id) => !foundVersionIds.has(id)),
    results,
  });
});
