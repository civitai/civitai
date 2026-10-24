import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { setCsamArchiveIncomplete } from '~/server/metrics/csam-archive.metrics';
import type { CsamArchiveIncompleteReason } from '~/server/metrics/csam-archive.metrics';
import type { CsamArchiveObjectKind } from '~/server/services/csam.service-new';
import { getCsamS3Client } from '~/server/services/csam.service-new';

type S3 = Pick<S3Client, 'send'>;

/** The `CsamReport.details` key that marks a report's evidence copy verified. */
export const EVIDENCE_VERIFIED_AT = 'evidenceVerifiedAt';

type Candidate = { id: number; type: string };

type ArchiveObjectRow = {
  csamReportId: number;
  kind: CsamArchiveObjectKind;
  key: string;
  etag: string | null;
  entries: number | null;
  namedExpected: number | null;
  namedMissing: number | null;
};

type CheckFailure = Exclude<CsamArchiveIncompleteReason, 'skipped' | 'stale'>;

const MEDIA_KIND: Partial<Record<string, CsamArchiveObjectKind>> = {
  Image: 'images',
  GeneratedImage: 'generatedImages',
  TrainingData: 'trainingData',
};

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
// End-of-central-directory record (22 bytes) plus the longest comment a zip may carry.
const EOCD_SEARCH_BYTES = 22 + 0xffff;

const normalizeEtag = (etag: string | null | undefined) => etag?.replace(/"/g, '') ?? null;

async function readRange(s3: S3, bucket: string, key: string, range: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error('empty range read');
  return Buffer.from(bytes);
}

/** Total entries in a zip, read from its central directory without downloading the archive. */
export async function readZipEntryCount(s3: S3, bucket: string, key: string) {
  const tail = await readRange(s3, bucket, key, `bytes=-${EOCD_SEARCH_BYTES}`);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    const offset = Number(tail.readBigUInt64LE(locator + 8));
    const record = await readRange(s3, bucket, key, `bytes=${offset}-${offset + 55}`);
    if (record.length < 40 || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) return null;
    return Number(record.readBigUInt64LE(32));
  }
  return tail.readUInt16LE(eocd + 10);
}

async function verifyObject(s3: S3, bucket: string, object: ArchiveObjectRow) {
  if (!object.etag) return 'unverifiable' as const;
  let etag: string | null;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
    etag = normalizeEtag(head.ETag);
  } catch (e) {
    if ((e as { name?: string })?.name === 'NotFound') return 'object_missing' as const;
    throw e;
  }
  if (etag !== normalizeEtag(object.etag)) return 'object_missing' as const;
  if (object.kind === 'base') return null;
  // Every media object is a zip. One the archive did not build (training data) has no recorded
  // count, so it must at least read as a complete, non-empty zip.
  const entries = await readZipEntryCount(s3, bucket, object.key);
  if (object.entries == null) return entries ? null : ('entries_mismatch' as const);
  return entries === object.entries ? null : ('entries_mismatch' as const);
}

const MARKED = Prisma.sql`COALESCE(jsonb_typeof(details) = 'object' AND jsonb_exists(details, ${EVIDENCE_VERIFIED_AT}), false)`;

/** Why a report's evidence cannot be marked verified, or null when every check passed. */
export async function checkReportEvidence(
  s3: S3,
  bucket: string,
  report: Candidate,
  objects: ArchiveObjectRow[]
): Promise<CheckFailure | null> {
  const mediaKind = MEDIA_KIND[report.type];
  if (!mediaKind) return 'unverifiable';
  const latest = (kind: CsamArchiveObjectKind) => objects.find((o) => o.kind === kind);
  const base = latest('base');
  const media = latest(mediaKind);
  if (!base || !media) return 'object_missing';

  if (mediaKind !== 'trainingData') {
    if (!media.namedExpected) return 'unverifiable';
    if (media.namedMissing !== 0) return 'images_missing';
  }
  for (const object of [base, media]) {
    const failure = await verifyObject(s3, bucket, object);
    if (failure) return failure;
  }
  return null;
}

/**
 * Checks every archived report not yet marked verified, marks the ones whose stored evidence
 * passes, and publishes how many reports are in each incomplete state.
 */
export async function checkCsamArchiveEvidence({
  s3 = getCsamS3Client(),
  bucket = env.CSAM_BUCKET_NAME as string,
  now = new Date(),
}: { s3?: S3; bucket?: string; now?: Date } = {}) {
  const counts: Record<CsamArchiveIncompleteReason, number> = {
    skipped: 0,
    stale: 0,
    images_missing: 0,
    object_missing: 0,
    entries_mismatch: 0,
    unverifiable: 0,
    check_error: 0,
  };

  const [pending] = await dbWrite.$queryRaw<{ skipped: number; stale: number }[]>`
    SELECT
      count(*) FILTER (WHERE details ->> 'archiveSkipped' IS NOT NULL)::int AS skipped,
      count(*) FILTER (
        WHERE details ->> 'archiveSkipped' IS NULL AND "reportSentAt" < now() - interval '6 hours'
      )::int AS stale
    FROM "CsamReport"
    WHERE "reportSentAt" IS NOT NULL AND "archivedAt" IS NULL
  `;
  counts.skipped = pending?.skipped ?? 0;
  counts.stale = pending?.stale ?? 0;

  // Reports archived before objects were recorded have nothing to check against and are left out.
  const candidates = await dbWrite.$queryRaw<Candidate[]>`
    SELECT c.id, c.type::text AS type
    FROM "CsamReport" c
    WHERE c."reportSentAt" IS NOT NULL
      AND c."archivedAt" IS NOT NULL
      AND c.type <> 'ExternalLink'
      AND NOT ${MARKED}
      AND EXISTS (SELECT 1 FROM "CsamReportArchiveObject" o WHERE o."csamReportId" = c.id)
    ORDER BY c.id
  `;
  const objects = candidates.length
    ? await dbWrite.$queryRaw<ArchiveObjectRow[]>`
        SELECT "csamReportId", kind, key, etag, entries, "namedExpected", "namedMissing"
        FROM "CsamReportArchiveObject"
        WHERE "csamReportId" = ANY(${candidates.map((c) => c.id)}::int[])
        ORDER BY "uploadedAt" DESC, id DESC
      `
    : [];

  let verified = 0;
  for (const report of candidates) {
    let failure: CheckFailure | null;
    try {
      failure = await checkReportEvidence(
        s3,
        bucket,
        report,
        objects.filter((o) => o.csamReportId === report.id)
      );
      if (!failure) {
        const marked = await dbWrite.$executeRaw`
          UPDATE "CsamReport"
          SET details = CASE WHEN jsonb_typeof(details) = 'object' THEN details ELSE '{}'::jsonb END
            || jsonb_build_object(${EVIDENCE_VERIFIED_AT}::text, ${now.toISOString()}::text)
          WHERE id = ${report.id} AND NOT ${MARKED}
        `;
        if (marked !== 1) failure = 'check_error';
      }
    } catch (e) {
      failure = 'check_error';
    }

    if (failure) counts[failure] += 1;
    else verified += 1;
    logToAxiom({
      name: 'csam-report',
      type: 'info',
      subType: 'archive-evidence-check',
      reportId: report.id,
      reportType: report.type,
      verified: !failure,
      reason: failure ?? undefined,
    }).catch(() => undefined);
  }

  setCsamArchiveIncomplete(counts, now);
  return { checked: candidates.length, verified, counts };
}
