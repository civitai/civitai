import { logToAxiom } from '~/server/logging/client';
import { processModelFileScanResult } from '~/server/services/model-file-scan-result.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await processModelFileScanResult(req);
    return res.status(200).json({ ok: true });
  } catch (error) {
    logToAxiom(
      {
        type: 'error',
        name: 'model-file-scan-result',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'webhooks'
    ).catch();
    return res.status(500).json({ error: 'Internal server error' });
  }
});
