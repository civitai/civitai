import { NextApiRequest, NextApiResponse } from 'next';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { modelScanResultSchema } from '~/server/schema/model-flag.schema';
import { ModelMeta } from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { upsertModelFlag } from '~/server/services/model-flag.service';
import { getModelModRules, unpublishModelById } from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { evaluateRules } from '~/server/utils/mod-rules';
import { ModelStatus, ModerationRuleAction } from '~/shared/utils/prisma/enums';

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
      select: {
        id: true,
        name: true,
        description: true,
        meta: true,
        userId: true,
        modelVersions: {
          where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
          select: { id: true, baseModel: true, name: true, description: true },
        },
      },
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
          await unpublishModelById({
            id: model.id,
            userId: -1,
            reason: 'other',
            customMessage: `Model put on hold by moderation rule: ${appliedRule.reason}`,
            meta: { ...(model.meta as ModelMeta), needsReview: true },
            isModerator: true,
          });
          await createNotification({
            category: NotificationCategory.System,
            key: `model-hold:${model.id}`,
            type: 'system-message',
            userId: model.userId,
            details: {
              message: `Your model "${
                model.name
              }" has been put on hold due to a moderation rule violation${
                appliedRule.reason ? ` by the following reason: ${appliedRule.reason}` : ''
              }. It's being reviewed by one of our moderators and it will be available once it has been approved.`,
              url: `/models/${model.id}`,
            },
          }).catch((error) =>
            logWebhook({
              message: 'Could not create notification when marking model as hold',
              data: {
                modelId: model.id,
                error: error.message,
                cause: error.cause,
                stack: error.stack,
              },
            })
          );
          break;
        case ModerationRuleAction.Block:
          await unpublishModelById({
            id: model.id,
            userId: -1,
            reason: 'other',
            customMessage: `Model blocked by moderation rule: ${appliedRule.reason}`,
            meta: model.meta as ModelMeta,
            isModerator: true,
          });
          await createNotification({
            category: NotificationCategory.System,
            key: `model-blocked:${model.id}`,
            type: 'system-message',
            userId: model.userId,
            details: {
              message: `Your model "${
                model.name
              }" has been blocked due to a moderation rule violation${
                appliedRule.reason ? ` by the following reason: ${appliedRule.reason}` : ''
              }. It's being reviewed by one of our moderators and it will be available once it has been approved.`,
              url: `/models/${model.id}`,
            },
          }).catch((error) =>
            logWebhook({
              message: 'Could not create notification when marking model as blocked',
              data: {
                modelId: model.id,
                error: error.message,
                cause: error.cause,
                stack: error.stack,
              },
            })
          );
          break;
        default:
          break;
      }
    }

    // Check scan results and handle accordingly
    const updatedModel = await dbWrite.model.update({
      where: { id: model.id },
      data: { scannedAt: new Date() },
      select: { status: true },
    });

    await upsertModelFlag({
      modelId: model.id,
      scanResult: {
        poi: data.flags.POI_flag,
        nsfw: data.flags.NSFW_flag,
        minor: data.flags.minor_flag,
        sfwOnly: data.flags.POI_flag || data.flags.minor_flag || !!data.flags.sfwOnly_flag,
        triggerWords: data.flags.triggerwords_flag,
        poiName: !!data.llm_interrogation.POIName?.length,
      },
      details: data.llm_interrogation,
    });

    await dataForModelsCache.bust(model.id);
    await modelsSearchIndex.queueUpdate([
      {
        id: model.id,
        action:
          updatedModel.status === ModelStatus.Unpublished ||
          updatedModel.status === ModelStatus.UnpublishedViolation
            ? SearchIndexUpdateQueueAction.Delete
            : SearchIndexUpdateQueueAction.Update,
      },
    ]);

    return res.status(200).json({ ok: true });
  } catch (error) {
    logWebhook({
      message: 'Unhandled exception',
      data: { error, input: req.body },
    });

    return res.status(500).json({ error: 'Internal Server Error', details: error });
  }
});
