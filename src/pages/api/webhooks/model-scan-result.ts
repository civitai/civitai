import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { modelScanResultSchema } from '~/server/schema/model-flag.schema';
import { ModelMeta } from '~/server/schema/model.schema';
import { upsertModelFlag } from '~/server/services/model-flag.service';
import { getModelModRules, unpublishModelById } from '~/server/services/model.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { evaluateRules } from '~/server/utils/mod-rules';
import { ModerationRuleAction } from '~/shared/utils/prisma/enums';

const logWebhook = (data: MixedObject) => {
  logToAxiom({ name: 'model-scan-result', type: 'error', ...data }, 'webhooks').catch(() => null);
};

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    logWebhook({ message: 'Wrong method', data: { method: req.method, input: req.body } });
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const result = modelScanResultSchema.safeParse(req.body);
  if (!result.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: result.error.format(), input: req.body },
    });
    return res.status(400).json({ error: 'Invalid Request', details: result.error.format() });
  }

  const data = result.data;
  if (data.status === 'failure') {
    logWebhook({
      message: 'Model scan failed',
      data: { input: req.body },
    });
    return res.status(500).json({ error: 'Could not scan model' });
  }

  try {
    const model = await dbRead.model.findUnique({
      where: { id: data.user_declared.content.id },
      select: { id: true, name: true, description: true, meta: true },
    });
    if (!model) {
      logWebhook({
        message: 'Model not found',
        data: { input: req.body },
      });
      return res.status(404).json({ error: 'Model not found' });
    }

    // Check against moderation rules
    const modelModRules = await getModelModRules();
    if (modelModRules.length) {
      const appliedRule = evaluateRules(modelModRules, model);

      switch (appliedRule?.action) {
        case ModerationRuleAction.Hold:
          await upsertModelFlag({
            modelId: model.id,
            details: { rule: appliedRule.definition },
          });
          break;
        case ModerationRuleAction.Block:
          await unpublishModelById({
            id: model.id,
            userId: -1,
            reason: 'other',
            customMessage: 'Model blocked by moderation rule',
            meta: model.meta as ModelMeta,
          });
        default:
          break;
      }
    }

    // Check scan results and handle accordingly
    await dbWrite.model.update({
      where: { id: model.id },
      data: { scannedAt: new Date() },
    });

    await upsertModelFlag({
      modelId: model.id,
      scanResult: {
        poi: data.flags.POI_flag,
        nsfw: data.flags.NSFW_flag,
        minor: data.flags.minor_flag,
        triggerWords: data.flags.triggerwords_flag,
        poiName: !!data.llm_interrogation.POIName?.length,
      },
      details: data.llm_interrogation,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    logWebhook({
      message: 'Unhandled exception',
      data: { error, input: req.body },
    });

    return res.status(500).json({ error: 'Internal Server Error', details: error });
  }
});
