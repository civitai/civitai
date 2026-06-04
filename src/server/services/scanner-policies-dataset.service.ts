import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { dbRead } from '~/server/db/client';
import { env } from '~/env/server';
import {
  type ExportDatasetInput,
  type ScannerPolicyMode,
  type TestCaseRow,
} from '~/server/schema/scanner-policies.schema';
import {
  getExportById,
  recordExport,
  removeExportRecord,
} from '~/server/services/scanner-policies.service';
import { buildInputWorkbook } from '~/server/services/scanner-policies-xlsx.service';
import { getS3Client } from '~/utils/s3-utils';

/**
 * Scanner-policies test bench — dataset export pipeline.
 *
 *   1. Pull all moderator verdicts for (mode, label) joined with content
 *      snapshots so we have the actual prompts.
 *   2. Dedupe by (contentHash, reviewedBy); majority-vote per contentHash;
 *      drop ties.
 *   3. Bucket by TP/FP/TN/FN. Stratified-cap at floor(max / 4) per bucket so
 *      a heavy bucket can't crowd out everything else.
 *   4. Build the xlsx, upload to S3 under `scanner-policies/datasets/...`,
 *      record the export in sysRedis for later re-listing.
 *
 * Returns the export record + signed download URL.
 */

const SCANNER_BY_MODE: Record<ScannerPolicyMode, string> = {
  prompt: 'xguard_prompt',
  text: 'xguard_text',
};

type VerdictRow = {
  contentHash: string;
  verdict: 'TruePositive' | 'FalsePositive' | 'TrueNegative' | 'FalseNegative' | 'Unsure';
  reviewedBy: number;
};

type ContentRow = {
  contentHash: string;
  content: { positivePrompt?: string; negativePrompt?: string; text?: string };
};

function verdictMeans(v: VerdictRow['verdict']): boolean | null {
  if (v === 'TruePositive' || v === 'FalseNegative') return true;
  if (v === 'FalsePositive' || v === 'TrueNegative') return false;
  return null; // Unsure — exclude from majority
}

function bucketVerdict(args: {
  groundTruth: boolean;
  agreementVerdicts: VerdictRow['verdict'][];
}): 'TP' | 'FP' | 'TN' | 'FN' {
  const counts: Record<string, number> = {};
  for (const v of args.agreementVerdicts) counts[v] = (counts[v] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0]?.[0];
  if (winner === 'TruePositive') return 'TP';
  if (winner === 'FalsePositive') return 'FP';
  if (winner === 'TrueNegative') return 'TN';
  if (winner === 'FalseNegative') return 'FN';
  return args.groundTruth ? 'TP' : 'TN';
}

/**
 * Stratified pick. With max=500 and 4 buckets, each bucket gets up to 125. If a
 * bucket runs short, leftover budget is redistributed to the others. Within a
 * bucket we prefer rows with the highest mod agreement (best signal first).
 */
function stratifiedSample<T extends { agreementCount: number }>(
  byBucket: Record<'TP' | 'FP' | 'TN' | 'FN', T[]>,
  max: number
): T[] {
  const buckets: ('TP' | 'FP' | 'TN' | 'FN')[] = ['TP', 'FP', 'TN', 'FN'];
  const sorted = Object.fromEntries(
    buckets.map((b) => [
      b,
      [...(byBucket[b] ?? [])].sort((a, b) => b.agreementCount - a.agreementCount),
    ])
  ) as Record<'TP' | 'FP' | 'TN' | 'FN', T[]>;

  const picked: T[] = [];
  let budget = max;
  const pending = new Set(buckets);

  while (budget > 0 && pending.size > 0) {
    const perBucket = Math.max(1, Math.floor(budget / pending.size));
    let pickedThisPass = 0;
    for (const b of [...pending]) {
      if (sorted[b].length === 0) {
        pending.delete(b);
        continue;
      }
      const take = Math.min(perBucket, sorted[b].length, budget);
      picked.push(...sorted[b].splice(0, take));
      budget -= take;
      pickedThisPass += take;
      if (sorted[b].length === 0) pending.delete(b);
      if (budget <= 0) break;
    }
    if (pickedThisPass === 0) break; // every remaining bucket is empty
  }

  return picked;
}

export type DatasetExportResult = {
  exportId: string;
  s3Key: string;
  filename: string;
  rowCount: number;
  perBucket: Record<'TP' | 'FP' | 'TN' | 'FN', number>;
};

export async function buildDatasetExport(
  input: ExportDatasetInput,
  userId: number
): Promise<DatasetExportResult> {
  const { mode, label, max } = input;
  const scanner = SCANNER_BY_MODE[mode];

  // 1. Pull verdicts for this (mode, label). Join with snapshot to filter by
  // scanner. Labels in `ScannerLabelReview` are stored lowercase by historical
  // convention while the XGuard registry uses PascalCase — match case-
  // insensitively so 'Young' (registry) catches 'young' / 'Young' (reviews).
  const verdicts = await dbRead.$queryRaw<VerdictRow[]>`
    SELECT r."contentHash", r."verdict", r."reviewedBy"
    FROM "ScannerLabelReview" r
    JOIN "ScannerContentSnapshot" s ON s."contentHash" = r."contentHash"
    WHERE lower(r."label") = lower(${label})
      AND s."scanner" = ${scanner}
  `;

  // 2. Group by contentHash, dedupe by reviewer, majority-vote.
  const byHash = new Map<string, VerdictRow[]>();
  for (const v of verdicts) {
    if (!byHash.has(v.contentHash)) byHash.set(v.contentHash, []);
    byHash.get(v.contentHash)!.push(v);
  }

  type DecidedRow = {
    contentHash: string;
    verdict: 'TP' | 'FP' | 'TN' | 'FN';
    expectedTrigger: boolean;
    modCount: number;
    agreementCount: number;
  };
  const decided: DecidedRow[] = [];
  for (const [contentHash, rows] of byHash) {
    const dedup = new Map<number, VerdictRow>();
    for (const r of rows) dedup.set(r.reviewedBy, r); // last-write-wins per reviewer
    const list = [...dedup.values()];
    const triggers = list.filter((r) => verdictMeans(r.verdict) === true);
    const secs = list.filter((r) => verdictMeans(r.verdict) === false);
    let groundTruth: boolean | null = null;
    if (list.length === 1) groundTruth = verdictMeans(list[0].verdict);
    else if (triggers.length > secs.length) groundTruth = true;
    else if (secs.length > triggers.length) groundTruth = false;
    if (groundTruth === null) continue; // tied or all-unsure — drop
    const winningSide = groundTruth ? triggers : secs;
    decided.push({
      contentHash,
      verdict: bucketVerdict({
        groundTruth,
        agreementVerdicts: winningSide.map((v) => v.verdict),
      }),
      expectedTrigger: groundTruth,
      modCount: list.length,
      agreementCount: winningSide.length,
    });
  }

  // 3. Stratified-cap.
  const byBucket: Record<'TP' | 'FP' | 'TN' | 'FN', DecidedRow[]> = {
    TP: [],
    FP: [],
    TN: [],
    FN: [],
  };
  for (const d of decided) byBucket[d.verdict].push(d);
  const picked = stratifiedSample(byBucket, max);

  // 4. Pull content for picked hashes — single round-trip.
  const hashes = picked.map((p) => p.contentHash);
  const content =
    hashes.length === 0
      ? []
      : await dbRead.$queryRaw<ContentRow[]>`
          SELECT s."contentHash", s."content"
          FROM "ScannerContentSnapshot" s
          WHERE s."scanner" = ${scanner}
            AND s."contentHash" = ANY(${hashes}::text[])
        `;
  const contentByHash = new Map(content.map((c) => [c.contentHash, c.content]));

  // 5. Build TestCaseRow array, sorted deterministically by contentHash.
  const testCases: TestCaseRow[] = picked
    .map((p) => {
      const c = contentByHash.get(p.contentHash);
      return {
        contentHash: p.contentHash,
        label,
        verdict: p.verdict,
        expectedTrigger: p.expectedTrigger,
        modCount: p.modCount,
        agreementCount: p.agreementCount,
        positivePrompt: mode === 'prompt' ? c?.positivePrompt ?? '' : c?.text ?? '',
        negativePrompt: mode === 'prompt' ? c?.negativePrompt ?? '' : undefined,
      };
    })
    .filter((tc) => tc.positivePrompt) // drop cases where the snapshot has no body
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));

  const perBucket: Record<'TP' | 'FP' | 'TN' | 'FN', number> = {
    TP: testCases.filter((t) => t.verdict === 'TP').length,
    FP: testCases.filter((t) => t.verdict === 'FP').length,
    TN: testCases.filter((t) => t.verdict === 'TN').length,
    FN: testCases.filter((t) => t.verdict === 'FN').length,
  };

  // 6. Build workbook + upload to S3.
  const datasetId = uuid();
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9-]+/g, '_');
  const filename = `${safeLabel}-${mode}-${stamp}.xlsx`;
  const s3Key = `scanner-policies/datasets/${mode}/${safeLabel}/${stamp}-${datasetId.slice(
    0,
    8
  )}.xlsx`;

  const buffer = await buildInputWorkbook(testCases, {
    datasetId,
    exportedAt: now.toISOString(),
    mode,
    label,
    rowCount: testCases.length,
  });

  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_UPLOAD_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  );

  // 7. Record in sysRedis.
  await recordExport({
    id: datasetId,
    mode,
    label,
    filename,
    s3Key,
    rowCount: testCases.length,
    createdBy: userId,
    createdAt: now.toISOString(),
  });

  return {
    exportId: datasetId,
    s3Key,
    filename,
    rowCount: testCases.length,
    perBucket,
  };
}

/**
 * Delete a dataset workbook entirely — both the S3 object and the sysRedis
 * record. Safe to call on a dataset that has a `lastRunId` since we never
 * snapshot result data anywhere else.
 */
export async function deleteExport(exportId: string): Promise<void> {
  const record = await getExportById(exportId);
  if (!record) return;

  // S3 first — if this fails we keep the record so the mod can retry.
  const s3 = getS3Client();
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_UPLOAD_BUCKET, Key: record.s3Key }));
  } catch (err) {
    // 404 means the object was already gone; any other failure should bubble
    // so the mod knows the cleanup wasn't complete.
    const name = (err as { name?: string }).name;
    if (name !== 'NoSuchKey' && name !== 'NotFound') throw err;
  }

  await removeExportRecord(exportId);
}
