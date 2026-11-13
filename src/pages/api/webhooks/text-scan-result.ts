import type { WorkflowEvent } from '@civitai/orchestration-client';
import { handleTextScanCallback } from '~/server/services/text-scan/callback';
import {
  handleTextCategoryCallback,
  TEXT_CATEGORY_CALLBACK_PASS,
} from '~/server/services/text-scan/category';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    if (req.query.pass === TEXT_CATEGORY_CALLBACK_PASS)
      await handleTextCategoryCallback(req.body as WorkflowEvent);
    else await handleTextScanCallback(req.body as WorkflowEvent);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
