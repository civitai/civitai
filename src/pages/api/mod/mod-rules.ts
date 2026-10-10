import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { bustImageModRulesCache } from '~/server/services/image.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { handleLogError } from '~/server/utils/errorHandling';
import { EntityType, ModerationRuleAction } from '~/shared/utils/prisma/enums';

const payloadSchema = z.object({
  id: z.number(),
  definition: z.record(z.string(), z.any()),
  userId: z.number(),
  action: z.enum(ModerationRuleAction),
  // Model rules are text-scan rules, managed in the moderator app (`/text-scan/model-rules`).
  entityType: z.literal('Image'),
  enabled: z.boolean().optional().default(true),
  order: z.number().optional(),
  reason: z.string().optional(),
});

const deleteQuerySchema = z.object({ id: z.coerce.number() });

export default WebhookEndpoint(async function handler(req, res) {
  if (req.method && !['POST', 'DELETE'].includes(req.method))
    return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    switch (req.method) {
      case 'POST':
        return upsertModRule(req, res);
      case 'DELETE':
        return deleteModRule(req, res);
      default: {
        return res.status(405).json({ error: 'Method Not Allowed' });
      }
    }
  } catch (error) {
    return handleEndpointError(res, error);
  }
});

async function upsertModRule(req: NextApiRequest, res: NextApiResponse) {
  if (req.body.id) {
    const schemaResult = payloadSchema.partial().safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

    try {
      const { id, userId, ...data } = schemaResult.data;
      const updated = await dbWrite.moderationRule.updateMany({
        where: { id, entityType: EntityType.Image },
        data,
      });
      if (!updated.count) return res.status(404).json({ error: 'No image rule with that id' });
    } catch (error) {
      return res.status(500).json({ error: 'Could not update rule', details: error });
    }
  } else {
    const schemaResult = payloadSchema.omit({ id: true }).safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format });

    try {
      const { userId: createdById, ...data } = schemaResult.data;
      await dbWrite.moderationRule.create({ data: { ...data, createdById } });
    } catch (error) {
      return res.status(500).json({ error: 'Could not create rule', details: error });
    }
  }

  await bustImageModRulesCache().catch(handleLogError);

  return res.status(200).json({ ok: true });
}

async function deleteModRule(req: NextApiRequest, res: NextApiResponse) {
  const schemaResult = deleteQuerySchema.safeParse(req.query);
  if (!schemaResult.success)
    return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

  try {
    const { id } = schemaResult.data;
    const deleted = await dbWrite.moderationRule.deleteMany({
      where: { id, entityType: EntityType.Image },
    });
    if (!deleted.count) return res.status(404).json({ error: 'No image rule with that id' });
    await bustImageModRulesCache().catch(handleLogError);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Could not delete rule', details: error });
  }
}
