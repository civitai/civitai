import { z } from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { createTrainingRequest } from '~/server/services/training.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  modelVersionId: z.number(),
  approve: z.boolean(),
});

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    logWebhook({ message: 'Wrong method', data: { method: req.method } });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    logWebhook({ message: 'Could not parse body', data: { error: bodyResults.error } });
    return res.status(400).json({ ok: false, errors: bodyResults.error });
  }

  const { approve, modelVersionId } = bodyResults.data;

  if (approve) {
    logWebhook({ message: 'Approved training dataset', type: 'info', data: { modelVersionId } });

    try {
      logWebhook({
        message: 'Resubmitting training request',
        type: 'info',
        data: { modelVersionId },
      });
      // TODO need userId here?
      await createTrainingRequest({ modelVersionId, skipModeration: true });
    } catch (e) {
      logWebhook({
        message: 'Failed to resubmit training request',
        data: { modelVersionId, important: true },
      });
    }
  } else {
    logWebhook({
      message: 'Denied training dataset',
      type: 'info',
      data: { modelVersionId, important: true },
    });

    // TODO refund, email, set job status to failed
  }

  return res.status(200).json({ ok: true });
});
