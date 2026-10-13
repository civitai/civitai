import type { WorkflowEvent } from '@civitai/client';
import { handleTextScanCallback } from '~/server/services/text-scan/callback';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    await handleTextScanCallback(req.body as WorkflowEvent);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
