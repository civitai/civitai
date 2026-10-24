import type { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { bustImageModRulesCache } from '~/server/services/image.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { handleLogError } from '~/server/utils/errorHandling';
import { ruleDefinitionSchema } from '~/server/utils/mod-rules';
import { EntityType, ModerationRuleAction } from '~/shared/utils/prisma/enums';

const payloadSchema = z.object({
  id: z.number(),
  definition: ruleDefinitionSchema,
  userId: z.number(),
  action: z.enum(ModerationRuleAction),
  // Model rules are text-scan rules, managed in the moderator app (`/text-scan/model-rules`).
  entityType: z.literal('Image'),
  enabled: z.boolean().optional().default(true),
  order: z.number().optional(),
  reason: z.string().optional(),
});

const deleteQuerySchema = z.object({ id: z.coerce.number() });

const ruleState = { definition: true, enabled: true, action: true, reason: true } as const;

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

// Every write records the rule's resulting state in its history, in the same transaction.
async function upsertModRule(req: NextApiRequest, res: NextApiResponse) {
  if (req.body.id) {
    const schemaResult = payloadSchema.partial().safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

    try {
      const { id, userId = constants.system.user.id, ...data } = schemaResult.data;
      if (id === undefined) return res.status(400).json({ error: 'Bad Request' });
      const updated = await dbWrite.$transaction(async (tx) => {
        const where = { id, entityType: EntityType.Image };
        const before = await tx.moderationRule.findFirst({
          where,
          select: { ...ruleState, createdById: true, updatedAt: true },
        });
        if (!before) return false;

        const { count } = await tx.moderationRule.updateMany({
          where,
          data: { ...data, definition: data.definition as Prisma.InputJsonObject | undefined },
        });
        if (!count) return false;
        const after = await tx.moderationRule.findFirstOrThrow({ where, select: ruleState });

        // A rule from before history was kept gets its prior state recorded first.
        const hasHistory = await tx.moderationRuleVersion.findFirst({
          where: { ruleId: id },
          select: { id: true },
        });
        const { createdById, updatedAt, ...prior } = before;
        await tx.moderationRuleVersion.createMany({
          data: [
            ...(hasHistory ? [] : [{ ruleId: id, ...prior, createdById, createdAt: updatedAt }]),
            { ruleId: id, ...after, createdById: userId },
          ] as Prisma.ModerationRuleVersionCreateManyInput[],
        });
        return true;
      });
      if (!updated) return res.status(404).json({ error: 'No image rule with that id' });
    } catch (error) {
      return res.status(500).json({ error: 'Could not update rule', details: error });
    }
  } else {
    const schemaResult = payloadSchema.omit({ id: true }).safeParse(req.body);
    if (!schemaResult.success)
      return res.status(400).json({ error: 'Bad Request', details: schemaResult.error.format() });

    try {
      const { userId: createdById, ...data } = schemaResult.data;
      const definition = data.definition as Prisma.InputJsonObject;
      await dbWrite.$transaction(async (tx) => {
        const rule = await tx.moderationRule.create({
          data: { ...data, definition, createdById },
          select: { id: true, ...ruleState },
        });
        const { id: ruleId, ...state } = rule;
        await tx.moderationRuleVersion.create({
          data: { ruleId, ...state, definition, createdById },
        });
      });
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
