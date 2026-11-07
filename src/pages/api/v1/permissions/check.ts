import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { hasEntityAccess } from '~/server/services/common.service';
import { sessionClient } from '~/server/auth/session-client';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { matchWebhookToken } from '~/server/utils/webhook-token';
import { commaDelimitedNumberArray, numericString } from '~/utils/zod-helpers';

const schema = z.object({
  entityType: z.enum(['ModelVersion']).default('ModelVersion'),
  entityIds: commaDelimitedNumberArray(),
  userId: numericString().optional(),
  permission: z.enum(['Generate']).default('Generate'),
});

// shortcut: per-pod caps reset each minute; move them to Redis if one pod's share proves too thin.
const CALLER_LOOKUPS_PER_MINUTE = 600;
const CALLER_LOGS_PER_MINUTE = 60;
const callerBudget = { minute: 0, lookups: 0, logs: 0 };

function takeCallerBudget(kind: 'lookups' | 'logs') {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== callerBudget.minute) Object.assign(callerBudget, { minute, lookups: 0, logs: 0 });
  const limit = kind === 'lookups' ? CALLER_LOOKUPS_PER_MINUTE : CALLER_LOGS_PER_MINUTE;
  return callerBudget[kind]++ < limit;
}

// Resolved keys, by token hash, so a frequent caller does not spend the lookup cap.
type ResolvedCaller = NonNullable<Awaited<ReturnType<typeof getSessionFromBearerToken>>>;
const RESOLVED_CALLER_TTL_MS = 5 * 60_000;
const RESOLVED_CALLER_MAX = 1000;
const resolvedCallers = new Map<string, { session: ResolvedCaller; at: number }>();

async function resolveCaller(bearer: string) {
  const key = createHash('sha256').update(bearer).digest('hex');
  const hit = resolvedCallers.get(key);
  if (hit && Date.now() - hit.at < RESOLVED_CALLER_TTL_MS) return hit.session;
  if (!takeCallerBudget('lookups')) return undefined;
  const session = await getSessionFromBearerToken(bearer, {
    allowClientCredentialsOnly: true,
  }).catch(() => null);
  if (session) {
    if (resolvedCallers.size >= RESOLVED_CALLER_MAX) resolvedCallers.clear();
    resolvedCallers.set(key, { session, at: Date.now() });
  }
  return session;
}

async function logCaller(req: NextApiRequest, userId: number | undefined, count: number) {
  const header = req.headers.authorization;
  const rawQueryToken = req.query.token;
  const queryToken = Array.isArray(rawQueryToken) ? rawQueryToken[0] : rawQueryToken;
  // Read the way getServerAuthSession reads it: header first, then `?token=` unless it is a webhook token.
  const bearer =
    (header ? header.split(' ')[1] : matchWebhookToken(queryToken) ? undefined : queryToken) ||
    undefined;
  const session = bearer ? await resolveCaller(bearer) : null;
  // Past the lookup cap: nothing is known about the caller, so nothing is logged.
  if (session === undefined) return;
  const callerUserId = session?.user?.id;
  if (callerUserId != null && env.PERMISSIONS_CHECK_SERVICE_USER_IDS.includes(callerUserId)) return;
  if (callerUserId != null && callerUserId === userId) return;
  if (!takeCallerBudget('logs')) return;

  logToAxiom({
    type: 'info',
    name: 'permissions-check-caller',
    caller: session ? 'other-user' : bearer ? 'unresolved-bearer' : 'anonymous',
    credentialSource: header ? 'header' : bearer ? 'query' : 'none',
    entityCount: count,
    ...(session && {
      callerUserId,
      apiKeyId: session.apiKeyId,
      apiKeyType: session.apiKeyType,
    }),
  }).catch(() => undefined);
}

export default PublicEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.query);
    if (!results.success)
      return res.status(400).json({ error: `Could not parse provided model versions array.` });

    const { entityIds, entityType, permission: publicPermission, userId } = results.data;

    if (entityIds.length === 0) {
      return res.status(200).json([]);
    }

    const permissions =
      publicPermission === 'Generate' ? EntityAccessPermission.EarlyAccessGeneration : null;

    if (!permissions) {
      return res.status(400).json({ error: 'Invalid permission' });
    }

    // Not awaited: identifying the caller may read the database and must not delay the answer.
    void logCaller(req, userId, entityIds.length).catch(() => undefined);

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
