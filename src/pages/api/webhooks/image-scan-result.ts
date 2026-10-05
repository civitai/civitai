import { getWorkflow, type WorkflowEvent } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { logToAxiom } from '~/server/logging/client';
import { imageScanWebhookCounter } from '~/server/prom/client';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import {
  captureJobFailureReason,
  LEGACY_SCAN_LOG,
  type OrchestratorJobEvent,
} from '~/server/services/image-scan-pipeline';
import {
  processImageScanWorkflow,
  type ScanResultStep,
} from '~/server/services/image-scan-result.service';
import {
  IMAGE_SCANNING_LOG,
  isImageScanningWorkflow,
  processImageScanningWorkflow,
} from '~/server/services/image-scanning-result.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  let log = LEGACY_SCAN_LOG;
  try {
    const scan = await loadScanEvent(req);
    if (scan?.imageScanning) {
      log = IMAGE_SCANNING_LOG;
      await processImageScanningWorkflow(scan.input);
    } else if (scan) {
      await processImageScanWorkflow({
        ...scan.input,
        steps: scan.input.steps as ScanResultStep[],
      });
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // Deleted between submit and callback: ACK so the orchestrator stops retrying.
    if (error.message.startsWith('image not found')) {
      imageScanWebhookCounter.inc({ result: 'deleted_skip' });
      return res.status(200).json({ ok: true, skipped: 'deleted' });
    }
    await logToAxiom({
      name: log.name,
      type: 'error',
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    });
    imageScanWebhookCounter.inc({ result: 'error' });
    return res.status(400).send({ error: error.message });
  }

  imageScanWebhookCounter.inc({ result: 'success' });
  return res.status(200).json({ ok: true });
});

// Route on the workflow's own steps, never the flag: both shapes are in flight across a flip.
async function loadScanEvent(req: NextApiRequest) {
  const event: WorkflowEvent = req.body;

  // Job events carry a top-level `jobId` and only a failure reason, which the terminal
  // workflow event reads back to classify the failure.
  const jobEvent = event as OrchestratorJobEvent;
  if (typeof jobEvent.jobId === 'string') {
    await captureJobFailureReason(jobEvent);
    return null;
  }

  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const imageId = data.metadata?.imageId as number | undefined;
  if (!imageId) throw new Error(`missing workflow metadata.imageId - ${event.workflowId}`);

  const steps: unknown[] = data.steps ?? [];
  const input = {
    workflowId: event.workflowId,
    status: event.status,
    imageId,
    articleImageScanning: getFeatureFlagsLazy({ req }).articleImageScanning,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
  };

  return { imageScanning: isImageScanningWorkflow(steps), input: { ...input, steps } };
}
