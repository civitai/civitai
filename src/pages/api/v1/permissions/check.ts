import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { hasEntityAccess } from '~/server/services/common.service';
import { sessionClient } from '~/server/auth/session-client';
import { getApiAuthSession } from '~/server/auth/api-auth-session';
import { env } from '~/env/server';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray, numericString } from '~/utils/zod-helpers';
import { MODEL_VIEW_SCOPE } from '~/server/auth/route-scopes';
import { matchesOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import {
  gatedVersionIds,
  getGateAudience,
  getGateRuleState,
  getGateSubjects,
} from '~/server/services/generation/generation.service';

const schema = z.object({
  entityType: z.enum(['ModelVersion']).default('ModelVersion'),
  entityIds: commaDelimitedNumberArray().refine((ids) => ids.length <= 100, {
    message: 'At most 100 entityIds',
  }),
  userId: numericString().optional(),
  permission: z.enum(['Generate']).default('Generate'),
});

/**
 * Whether the caller may ask about `userId`: the orchestrator's service token, that user, a
 * moderator, or a listed service account.
 */
async function mayAskAbout(req: NextApiRequest, res: NextApiResponse, userId: number) {
  if (matchesOrchestratorServiceToken(req)) return true;
  const caller = (
    await getApiAuthSession(
      { req, res },
      { whenBanned: 'anonymous', scope: MODEL_VIEW_SCOPE }
    ).catch(() => null)
  )?.user;
  if (!caller) return false;
  return (
    caller.id === userId ||
    !!caller.isModerator ||
    env.PERMISSIONS_CHECK_SERVICE_USER_IDS.includes(caller.id)
  );
}

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.query);
    if (!results.success)
      return res.status(400).json({ error: `Could not parse provided model versions array.` });

    const { entityIds, entityType, permission: publicPermission } = results.data;
    let { userId } = results.data;

    if (entityIds.length === 0) {
      return res.status(200).json([]);
    }

    const permissions =
      publicPermission === 'Generate' ? EntityAccessPermission.EarlyAccessGeneration : null;

    if (!permissions) {
      return res.status(400).json({ error: 'Invalid permission' });
    }

    // The gate pass always needs a trusted user: its answer would otherwise say whether any user is
    // a moderator, tester or member.
    const trustedUserId =
      userId != null && (await mayAskAbout(req, res, userId)) ? userId : undefined;
    if (userId != null && env.PERMISSIONS_CHECK_GATE) {
      // Shared caches key on the URL, so neither answer may be stored: the allowed one is about this
      // user, and the refused one must not be served to an allowed caller.
      res.setHeader('Cache-Control', 'private, no-store');
      userId = trustedUserId;
    }

    const sessionUser = userId != null ? await sessionClient.getSessionUserById(userId) : null;

    try {
      const access = await hasEntityAccess({
        userId,
        isModerator: sessionUser?.isModerator,
        entityType,
        entityIds,
        permissions,
      });

      const data: Record<number, boolean> = {};

      access.forEach((r) => {
        data[r.entityId] = r.hasAccess;
      });

      const restricted = await dbRead.modelVersion.findMany({
        where: { id: { in: entityIds }, model: { poi: true } },
        select: { id: true, model: { select: { userId: true } } },
      });
      const viewer = userId != null ? { id: userId, isModerator: sessionUser?.isModerator } : null;
      for (const version of restricted) {
        if (version.id in data && !canViewPoiModel(true, version.model.userId, viewer))
          data[version.id] = false;
      }

      // Generation gate rules: a gated version is refused to anyone outside the rule's audience.
      const [versions, ruleState] = await Promise.all([
        dbRead.modelVersion.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, baseModel: true, meta: true },
        }),
        getGateRuleState(),
      ]);
      const subjects = await getGateSubjects(
        versions.map((v) => ({
          id: v.id,
          baseModel: v.baseModel,
          generationAlias: (v.meta as ModelVersionMeta | null)?.generationAlias,
        }))
      );
      const gatedForAnyone = gatedVersionIds(subjects, ruleState);
      if (gatedForAnyone.size) {
        res.setHeader('Cache-Control', 'private, no-store');
        const trustedUser =
          trustedUserId == null
            ? undefined
            : trustedUserId === sessionUser?.id
            ? sessionUser
            : await sessionClient.getSessionUserById(trustedUserId);
        const audience = await getGateAudience(trustedUser ?? undefined);
        const refused =
          !ruleState.known && audience.isModerator
            ? new Set<number>()
            : gatedVersionIds(subjects, ruleState, audience);
        for (const id of refused) if (id in data) data[id] = false;
      }

      return res.json(data);
    } catch (error) {
      // civitai#3845 (population B): this used to serialize the whole error
      // OBJECT. `hasEntityAccess` runs `$queryRaw`, so a failure arrives as a
      // Prisma P2010 whose enumerable own props carry the raw database message.
      return handleEndpointError(res, error);
    }
  },
  ['GET']
);
