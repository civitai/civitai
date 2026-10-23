import type { WorkflowEvent } from '@civitai/orchestration-client';
import { logToAxiom } from '~/server/logging/client';
import { processAudioScanCallback } from '~/server/services/video-audio-scan.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const event = (req.body ?? {}) as Partial<WorkflowEvent>;
    const result = await processAudioScanCallback(event.workflowId);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    // Only a failed read of a workflow we submitted lands here; a 400 has the orchestrator retry it.
    const error = e instanceof Error ? e : new Error(String(e));
    await logToAxiom({
      name: 'video-audio-scan',
      type: 'error',
      message: error.message,
      stack: error.stack,
    });
    return res.status(400).json({ ok: false, error: error.message });
  }
});
