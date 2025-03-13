import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { bustImageModRulesCache } from '~/server/services/image.service';
import { bustModelModRulesCache } from '~/server/services/model.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';
import { handleLogError } from '~/server/utils/errorHandling';
import { EntityType, ModerationRuleAction } from '~/shared/utils/prisma/enums';

const payloadSchema = z.object({
  id: z.number(),
  definition: z.object({}).passthrough(),
  action: z.nativeEnum(ModerationRuleAction),
  entityType: z.enum(['Model', 'Image']),
  enabled: z.boolean().optional().default(true),
  order: z.number().optional(),
});

const deleteQuerySchema = z.object({
  id: z.number(),
});

export default ModEndpoint(
  async function handler(req, res) {
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
  },
  ['POST', 'DELETE']
);

async function upsertModRule(req: NextApiRequest, res: NextApiResponse) {
  if (req.body.id) {
    const schemaResult = payloadSchema.partial().safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

    try {
      const { id, ...data } = schemaResult.data;
      await dbWrite.moderationRule.update({ where: { id }, data });
    } catch (error) {
      return res.status(500).json({ error: 'Could not update rule', details: error });
    }
  } else {
    const schemaResult = payloadSchema.omit({ id: true }).safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format });

    try {
      const data = schemaResult.data;
      await dbWrite.moderationRule.create({ data });
    } catch (error) {
      return res.status(500).json({ error: 'Could not create rule', details: error });
    }
  }

  if (req.body.entityType === EntityType.Model)
    await bustModelModRulesCache().catch(handleLogError);
  else if (req.body.entityType === EntityType.Image)
    await bustImageModRulesCache().catch(handleLogError);

  return res.status(200).json({ ok: true });
}

async function deleteModRule(req: NextApiRequest, res: NextApiResponse) {
  const schemaResult = deleteQuerySchema.safeParse(req.query);
  if (!schemaResult.success)
    return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

  try {
    const { id } = schemaResult.data;
    const result = await dbWrite.moderationRule.delete({ where: { id } });

    if (result.entityType === EntityType.Model)
      await bustModelModRulesCache().catch(handleLogError);
    else if (result.entityType === EntityType.Image)
      await bustImageModRulesCache().catch(handleLogError);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Could not delete rule', details: error });
  }
}
