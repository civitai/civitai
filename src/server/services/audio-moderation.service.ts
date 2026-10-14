import { randomUUID } from 'crypto';
import { getWorkflow, type Workflow, type WorkflowStepTemplate } from '@civitai/client';
import type { AudioModerationScan } from '@prisma/client';
import { audioModerationResultSchema } from '@civitai/shared/audio-moderation';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { env } from '~/env/server';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { submitWorkflowWithRetry } from '~/server/services/orchestrator/workflows';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { isAllowedImageScanUrl, normalizeImageScanUrl } from '~/server/utils/image-scan-url';

const MAX_ATTEMPTS = 5;
const metadataSchema = z.object({
  audioScanId: z.number().int().positive(),
  audioScanAttempt: z.string().uuid(),
});
const stepSchema = z.object({
  $type: z.literal('audioModeration'),
  name: z.literal('audioScan'),
  output: audioModerationResultSchema,
});

async function failScan(scan: AudioModerationScan, message: string) {
  await dbWrite.audioModerationScan.updateMany({
    where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
    data: {
      status: 'Failed',
      error: message.slice(0, 2000),
      nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** scan.attempts),
    },
  });
}

export async function recordAudioModerationWorkflow(workflow: Workflow) {
  if (!workflow.id) return;
  const metadata = metadataSchema.safeParse(workflow.metadata);
  if (!metadata.success) return;
  const scan = await dbWrite.audioModerationScan.findFirst({
    where: {
      id: metadata.data.audioScanId,
      attemptId: metadata.data.audioScanAttempt,
      status: 'Pending',
    },
  });
  if (!scan || (scan.workflowId && scan.workflowId !== workflow.id)) return;
  if (workflow.status === 'succeeded') {
    const step = (workflow.steps ?? []).find((item) => item.name === 'audioScan');
    const parsed = stepSchema.safeParse(step);
    if (!parsed.success) {
      await failScan(scan, 'Workflow completed without a complete audio moderation result');
      return;
    }
    await dbWrite.audioModerationScan.updateMany({
      where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
      data: {
        status: 'Succeeded',
        workflowId: workflow.id,
        result: parsed.data.output,
        flagged: parsed.data.output.hasAudio ? parsed.data.output.sexualizedMinors : null,
        completedAt: new Date(),
        error: null,
      },
    });
  } else if (['failed', 'expired', 'canceled'].includes(workflow.status ?? '')) {
    await failScan(scan, `Workflow ${workflow.status}`);
  }
}

export async function handleAudioModerationCallback(body: unknown) {
  const { workflowId } = z.object({ workflowId: z.string().min(1) }).parse(body);
  // Read the authenticated workflow; a callback body is never the source of a verdict.
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
    signal: AbortSignal.timeout(15_000),
  });
  if (!data) throw new Error('Audio moderation workflow is unavailable');
  await recordAudioModerationWorkflow(data);
}

async function processScan(original: AudioModerationScan) {
  const lease = await dbWrite.audioModerationScan.updateMany({
    where: {
      id: original.id,
      updatedAt: original.updatedAt,
      nextAttemptAt: original.nextAttemptAt,
      status: original.status,
    },
    data: { nextAttemptAt: new Date(Date.now() + 120_000) },
  });
  if (!lease.count) return;
  let scan = original;
  try {
    if (scan.status === 'Failed') {
      const reset = await dbWrite.audioModerationScan.updateMany({
        where: { id: scan.id, attemptId: scan.attemptId, status: 'Failed' },
        data: {
          status: 'Pending',
          attemptId: randomUUID(),
          workflowId: null,
          startedAt: null,
          error: null,
        },
      });
      if (!reset.count) return;
      scan = await dbWrite.audioModerationScan.findUniqueOrThrow({ where: { id: scan.id } });
    }
    if (scan.startedAt && Date.now() - scan.startedAt.getTime() > 2 * 60 * 60_000) {
      await failScan(scan, 'Audio moderation workflow exceeded the reconciliation deadline');
      return;
    }
    if (scan.workflowId) {
      await handleAudioModerationCallback({ workflowId: scan.workflowId });
      return;
    }
    // An accepted submit may have lost its response. Allow its callback until the deadline,
    // without issuing more than the bounded number of submissions for this attempt.
    if (scan.attempts >= MAX_ATTEMPTS) return;
    const image =
      scan.imageId === null
        ? null
        : await dbWrite.image.findUnique({
            where: { id: scan.imageId },
            select: { url: true, type: true },
          });
    if (!image || image.url !== scan.sourceUrl || !['video', 'audio'].includes(image.type)) {
      await dbWrite.audioModerationScan.updateMany({
        where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
        data: { status: 'Canceled', error: 'Media was removed or replaced' },
      });
      return;
    }
    if (!isAllowedImageScanUrl(scan.sourceUrl)) {
      await failScan(scan, 'Media URL is not allowed');
      await dbWrite.audioModerationScan.updateMany({
        where: { id: scan.id, status: 'Failed' },
        data: { attempts: MAX_ATTEMPTS },
      });
      return;
    }
    await dbWrite.audioModerationScan.updateMany({
      where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
      data: { attempts: { increment: 1 }, startedAt: scan.startedAt ?? new Date() },
    });
    const { data } = await submitWorkflowWithRetry(
      {
        client: internalOrchestratorClient,
        body: {
          externalId: scan.attemptId,
          currencies: [],
          metadata: { audioScanId: scan.id, audioScanAttempt: scan.attemptId },
          steps: [
            {
              $type: 'audioModeration',
              name: 'audioScan',
              input: {
                mediaUrl: getEdgeUrl(normalizeImageScanUrl(scan.sourceUrl), {
                  type: image.type,
                  original: true,
                }),
                transcriber: 'auto',
              },
            },
          ] as unknown as WorkflowStepTemplate[],
          callbacks: [
            {
              url: `${
                env.NEXTAUTH_URL
              }/api/webhooks/audio-moderation-result?token=${encodeURIComponent(
                env.WEBHOOK_TOKEN
              )}`,
              type: [
                'workflow:succeeded',
                'workflow:failed',
                'workflow:expired',
                'workflow:canceled',
              ],
            },
          ],
        },
      },
      { perAttemptTimeoutMs: 15_000 }
    );
    if (!data?.id) throw new Error('Audio moderation submission failed');
    // A fast callback may already have completed the scan while the submit response was in flight.
    await dbWrite.audioModerationScan.updateMany({
      where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
      data: { workflowId: data.id, error: null },
    });
  } catch (error) {
    // Keep the same externalId after an uncertain submit, so retry cannot duplicate an accepted job.
    await dbWrite.audioModerationScan.updateMany({
      where: { id: scan.id, attemptId: scan.attemptId, status: 'Pending' },
      data: {
        error: error instanceof Error ? error.message.slice(0, 2000) : 'Audio moderation failed',
      },
    });
  }
}

export async function processAudioModerationQueue(checkCanceled?: () => void) {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.POSTED_AUDIO_MODERATION))) return { processed: 0 };
  const scans = await dbWrite.audioModerationScan.findMany({
    where: {
      status: { in: ['Pending', 'Failed'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ attempts: { lt: MAX_ATTEMPTS } }, { status: 'Pending', startedAt: { not: null } }],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: 100,
  });
  const deadline = Date.now() + 180_000;
  let processed = 0;
  for (let offset = 0; offset < scans.length && Date.now() < deadline; offset += 5) {
    checkCanceled?.();
    const batch = scans.slice(offset, offset + 5);
    await Promise.all(batch.map(processScan));
    processed += batch.length;
  }
  return { processed };
}
