import type { S3Client } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { deleteFilesForModelVersionCache } from '~/server/services/model-file.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  getDownloadUrlByFileId,
  isDefiniteNotFound,
  StorageResolverError,
} from '~/utils/delivery-worker';
import {
  abortMultipartUpload,
  getB2S3Client,
  getS3Client,
  headObject,
  resolveModelFileDeleteTarget,
  urlsSafeToDelete,
} from '~/utils/s3-utils';
import { deregisterFileLocationsByFile } from '~/utils/storage-resolver';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

/**
 * Permanently removes the Training Data files of the given model versions: every stored version
 * of each object and any unfinished upload of it, the storage-resolver registration, then the
 * ModelFile row.
 *
 * GET  /api/admin/temp/purge-training-data-files?token=<WEBHOOK_TOKEN>&modelVersionIds=1,2,3
 *        dry run: reports what is stored and what would be removed
 * POST same query plus &dryRun=false   removes it
 *
 * Refuses any file that is not the Training Data of a trained version whose model is already
 * deleted, whose object is outside the owner's training upload path, that another row still
 * references, that was already purged (a quarantine copy may exist), or whose version is in a CSAM
 * report whose evidence is not archived yet. A destructive run also requires the object to be
 * found both at its key and through the storage resolver first.
 */

const schema = z.object({
  modelVersionIds: commaDelimitedNumberArray(z.array(z.number().int().positive()).min(1).max(20)),
  dryRun: booleanString().default(true),
});

type StoredVersion = { versionId: string | undefined; isDeleteMarker: boolean; size?: number };
type Presence = 'present' | 'absent' | 'unknown';

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

// Parts of an abandoned multipart upload are invisible to both the version listing and HEAD.
async function listUnfinishedUploads(s3: S3Client, bucket: string, key: string) {
  const res = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }));
  return (res.Uploads ?? []).filter((u) => u.Key === key).map((u) => u.UploadId);
}

// Tiering can move bytes without rewriting ModelFile.url, so the stored url alone cannot show
// that nothing remains. The resolver answers for wherever the file is registered.
async function resolverPresence(fileId: number): Promise<Presence> {
  let url: string;
  try {
    ({ url } = await getDownloadUrlByFileId(fileId));
  } catch (e) {
    return e instanceof StorageResolverError && isDefiniteNotFound(e) ? 'absent' : 'unknown';
  }
  try {
    // A one-byte GET rather than HEAD: the resolved url is signed for GET.
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    if (res.ok) return 'present';
    if (res.status === 404) return 'absent';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function versionsHeldByCsamReports(modelVersionIds: number[]) {
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT DISTINCT e.value::int AS id
    FROM "CsamReport" r
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(r.details->'modelVersionIds') = 'array'
        THEN r.details->'modelVersionIds' ELSE '[]'::jsonb END
    ) AS e(value)
    WHERE r."archivedAt" IS NULL
      AND e.value = ANY(${modelVersionIds.map(String)}::text[])
  `;
  return new Set(rows.map((r) => Number(r.id)));
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { modelVersionIds, dryRun } = parsed.data;
  if (!dryRun && req.method !== 'POST')
    return res.status(405).json({ error: 'dryRun=false requires POST' });

  const files = await dbWrite.modelFile.findMany({
    where: { modelVersionId: { in: modelVersionIds }, type: 'Training Data' },
    select: {
      id: true,
      url: true,
      dataPurged: true,
      modelVersionId: true,
      modelVersion: {
        select: { uploadType: true, model: { select: { userId: true, deletedAt: true } } },
      },
    },
  });
  const csamHeld = await versionsHeldByCsamReports(modelVersionIds);

  const results = [];
  for (const file of files) {
    const result: Record<string, unknown> = {
      fileId: file.id,
      modelVersionId: file.modelVersionId,
    };
    results.push(result);

    const { uploadType, model } = file.modelVersion;
    if (uploadType !== 'Trained') {
      result.skipped = 'not-a-trained-version';
      continue;
    }
    if (!model.deletedAt) {
      result.skipped = 'model-not-deleted';
      continue;
    }
    if (file.dataPurged) {
      result.skipped = 'already-purged';
      continue;
    }
    if (csamHeld.has(file.modelVersionId)) {
      result.skipped = 'held-by-unarchived-csam-report';
      continue;
    }
    const target = resolveModelFileDeleteTarget(file.url);
    if (!target.ok) {
      result.skipped = target.reason;
      continue;
    }
    if (!target.key.startsWith(`training-images/${model.userId}/`)) {
      result.skipped = 'outside-owner-upload-path';
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
      const uploadsBefore = await listUnfinishedUploads(s3, target.bucket, target.key);
      result.storedVersionsBefore = before;
      result.unfinishedUploadsBefore = uploadsBefore.length;
      result.headBefore = (await headObject(target.bucket, target.key, s3)).status;
      result.resolverBefore = await resolverPresence(file.id);
      if (before.some((v) => !v.versionId) || uploadsBefore.some((id) => !id)) {
        result.error = 'a stored version or upload has no id; nothing deleted';
        continue;
      }
      // Without a positive before-state an all-absent after-state proves nothing: a url that
      // resolves to the wrong key would pass every check and orphan the real bytes.
      if (!before.some((v) => !v.isDeleteMarker) || result.resolverBefore !== 'present') {
        result.error = 'object not confirmed at its key and through the resolver; nothing deleted';
        continue;
      }
      if (dryRun) continue;

      for (const v of before)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: target.bucket,
            Key: target.key,
            VersionId: v.versionId,
          })
        );
      for (const uploadId of uploadsBefore)
        await abortMultipartUpload(target.bucket, target.key, uploadId!, s3);

      const after = await listStoredVersions(s3, target.bucket, target.key);
      const uploadsAfter = await listUnfinishedUploads(s3, target.bucket, target.key);
      const head = await headObject(target.bucket, target.key, s3);
      const resolver = await resolverPresence(file.id);
      result.storedVersionsAfter = after;
      result.unfinishedUploadsAfter = uploadsAfter.length;
      result.headAfter = head.status;
      result.resolverAfter = resolver;
      if (
        after.length > 0 ||
        uploadsAfter.length > 0 ||
        head.status !== 'absent' ||
        resolver !== 'absent'
      ) {
        result.error = 'not confirmed gone after delete; row kept';
        continue;
      }

      const deregistered = await deregisterFileLocationsByFile([file.id]);
      result.resolverDeregistered = deregistered?.deleted ?? null;
      // The file was served through the resolver before, so it is registered: removing nothing
      // means the call failed, which the helper reports as zero rather than throwing.
      if (!deregistered || deregistered.deleted < 1) {
        result.error = 'resolver registration not removed; row kept';
        continue;
      }
      await dbWrite.modelFile.delete({ where: { id: file.id } });
      result.rowDeleted = true;
      await deleteFilesForModelVersionCache(file.modelVersionId);
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
