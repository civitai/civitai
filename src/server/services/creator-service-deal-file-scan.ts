import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { getWorkflow, submitWorkflow } from '@civitai/orchestration-client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { ensureFliptInitialized, getFliptClientSync } from '~/server/flipt/client';
import { getFeatureFliptKey } from '~/server/services/feature-flags.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getBucket, getS3Client } from '~/utils/s3-utils';

/**
 * The seam between a delivered Final and the malware scan.
 *
 * The bytes a buyer would download are copied to the orchestrator as a blob and run through its
 * virus and pickle scans. Nothing calls back: the unpack job polls the workflow (`readFinalScan`)
 * and records the malware verdict, which `recordFinalScanResult` in the file service then requires
 * before a Final can pass. A submission that fails, or a scan that cannot reach a verdict, leaves the
 * Final Pending for the job to submit again or give up on; it is never passed for want of a scan.
 *
 * The orchestrator offers no way to delete the blob; it expires on its own.
 */
export type FinalScanTarget = {
  id: number;
  dealId: number;
  s3Key: string;
  mimeType: string;
  size: number;
};

// Three uploads can run in one unpack job run, which must finish inside its 40 minute lock.
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;

const blobAir = (blobId: string) => `urn:air:other:other:orchestrator:blob@${blobId}`;

async function uploadBlob(target: FinalScanTarget) {
  const object = await getS3Client().send(
    new GetObjectCommand({ Bucket: await getBucket(), Key: target.s3Key })
  );
  if (!object.Body) throw new Error('Empty object body');
  const response = await fetch(
    `${env.ORCHESTRATOR_ENDPOINT?.replace(/\/$/, '')}/v2/consumer/blobs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(target.size),
      },
      body: object.Body.transformToWebStream(),
      duplex: 'half',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    } as RequestInit
  );
  if (!response.ok) throw new Error(`Blob upload failed: ${response.status}`);
  const { id } = (await response.json()) as { id?: string };
  if (!id) throw new Error('Blob upload returned no id');
  return id;
}

/**
 * Submits one Final to the scan, or does nothing when it is not waiting for one. The attempt is
 * counted before anything is sent, so a file whose submissions keep failing still reaches the
 * attempt limit. Outside production without an orchestrator token nothing is submitted and the
 * Final stays Pending: a scan is never faked.
 */
export async function submitFinalScan(target: FinalScanTarget): Promise<'Pending'> {
  if (!isProd && !env.ORCHESTRATOR_ACCESS_TOKEN) return 'Pending';

  const [claimed] = await dbWrite.$queryRaw<{ attempt: number }[]>`
    UPDATE "ServiceDealFile"
    SET "malwareScanAttempts" = "malwareScanAttempts" + 1, "malwareScanSubmittedAt" = now(),
      "malwareScanStartedAt" = COALESCE("malwareScanStartedAt", now())
    WHERE "id" = ${target.id}::int
      AND "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND "malwareScanWorkflowId" IS NULL
    RETURNING "malwareScanAttempts" AS "attempt"`;
  if (!claimed) return 'Pending';

  const air = blobAir(await uploadBlob(target));
  const metadata = { fileId: target.id };
  const { data } = await submitWorkflow({
    client: internalOrchestratorClient,
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    body: {
      metadata,
      currencies: [],
      tags: ['civitai', 'creator-services-final-scan'],
      steps: [
        { $type: 'modelClamScan', name: 'clamScan', metadata, input: { model: air } },
        { $type: 'modelPickleScan', name: 'pickleScan', metadata, input: { model: air } },
      ] as WorkflowStepTemplate[],
    },
  });
  if (!data?.id) throw new Error('Scan workflow was not accepted');

  await dbWrite.$executeRaw`
    UPDATE "ServiceDealFile" SET "malwareScanWorkflowId" = ${data.id}::text
    WHERE "id" = ${target.id}::int
      AND "malwareScanStatus" = 'Pending'::"ServiceDealFileScanStatus"
      AND "malwareScanWorkflowId" IS NULL
      AND "malwareScanAttempts" = ${claimed.attempt}::int`;
  return 'Pending';
}

/** What a scan workflow says about its file: a verdict, a scan to run again, or nothing yet. */
export type FinalScanReading = 'Passed' | 'Failed' | 'Retry' | 'Running';

type ScanStep = {
  $type?: string;
  output?: {
    status?: string | null;
    infected?: boolean | null;
    dangerousImportsFound?: boolean | null;
  } | null;
};

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

/**
 * Reads a scan workflow. The verdict is in each step's output, never the workflow's status: a
 * workflow that found a virus still succeeds. Anything found fails the file even if the other step
 * did not finish; a pass needs both steps to have run and reported clean. Every other outcome,
 * including a status this code does not know, is a scan to run again.
 */
export function readFinalScan(workflow: { status?: string | null; steps?: unknown[] | null }) {
  const steps = (workflow.steps ?? []) as ScanStep[];
  const clam = steps.find((step) => step.$type === 'modelClamScan')?.output;
  const pickle = steps.find((step) => step.$type === 'modelPickleScan')?.output;

  if (clam?.infected === true || clam?.status === 'infected') return 'Failed';
  if (pickle?.dangerousImportsFound === true || pickle?.status === 'dangerousImportsFound')
    return 'Failed';
  if (!TERMINAL.has(workflow.status ?? '')) return 'Running';
  if (workflow.status !== 'succeeded') return 'Retry';
  const pickleClean = pickle?.status === 'clean' || !!pickle?.status?.startsWith('skipped');
  return clam?.status === 'clean' && pickleClean ? 'Passed' : 'Retry';
}

/** Fetches and reads a scan workflow; null when the orchestrator did not answer. */
export async function getFinalScanReading(workflowId: string): Promise<FinalScanReading | null> {
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) return null;
  return readFinalScan(data as { status?: string; steps?: unknown[] });
}

/**
 * Whether Finals go to the malware scan. Off means the step is skipped: the Final's
 * `malwareScanStatus` is recorded as NotScanned, never Passed, and every image inside it is still
 * scanned and still decides the verdict.
 *
 * Skipped only on an answer from Flipt: the flag set off, or not created yet. When Flipt cannot be
 * reached the scan stays on, so an outage never lets a Final through unscanned. `isFlipt` turns both
 * cases into false, so this asks the client directly. Read through one synthetic entity, so launch it
 * by setting the flag's `enabled`, not by percentage.
 */
export async function isFinalsMalwareScanOn() {
  const flagKey = getFeatureFliptKey('creatorServicesFinalsMalwareScan');
  if (!flagKey) return true;
  try {
    await ensureFliptInitialized();
  } catch {
    return true;
  }
  const client = getFliptClientSync();
  if (!client) return true;
  try {
    return client.evaluateBoolean({
      flagKey,
      entityId: '0',
      context: { userId: '0', isModerator: 'false' },
    }).enabled;
  } catch {
    // The client has a config and the flag is not in it.
    return false;
  }
}
