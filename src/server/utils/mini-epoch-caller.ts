import type { NextApiRequest } from 'next';
import type { Session } from '~/types/session';
import { matchesOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import { getRequestCredential } from '~/server/auth/request-credential';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';

export type MiniEpochGateMode = 'off' | 'log' | 'enforce';

export type MiniEpochCallerClass =
  | 'owner'
  | 'moderator'
  | 'orchestrator'
  | 'grantee'
  | 'anonymous'
  | 'other';

/** What the request's credential resolved to. Presence and kind only, never a value. */
export type MiniEpochCredential =
  | 'none'
  | 'session'
  | 'api-key'
  | 'oauth'
  | 'orchestrator'
  | 'unrecognized';

export async function getMiniEpochGateMode(): Promise<MiniEpochGateMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.MINI_EPOCH_CALLER_GATE);
  return variant === 'log' || variant === 'enforce' ? variant : 'off';
}

function credentialKind(
  req: NextApiRequest,
  user: Session['user'] | undefined,
  orchestrator: boolean
): MiniEpochCredential {
  if (orchestrator) return 'orchestrator';
  const subject = getRequestCredential(req).subject?.type;
  if (subject === 'oauth') return 'oauth';
  if (subject === 'apiKey') return 'api-key';
  if (req.headers?.authorization) return 'unrecognized';
  return user ? 'session' : 'none';
}

/**
 * Classifies the caller of the epoch arm for a Private version, logs it, and answers whether the
 * epoch url is withheld from them. Only `enforce` ever withholds.
 */
export async function evaluateMiniEpochCaller({
  req,
  user,
  modelVersionId,
  ownerId,
  mode,
}: {
  req: NextApiRequest;
  user: Session['user'] | undefined;
  modelVersionId: number;
  ownerId: number;
  mode: Exclude<MiniEpochGateMode, 'off'>;
}): Promise<{ callerClass: MiniEpochCallerClass; withhold: boolean }> {
  const orchestrator = matchesOrchestratorServiceToken(req);

  let callerClass: MiniEpochCallerClass;
  if (user?.id && user.id === ownerId) callerClass = 'owner';
  else if (user?.isModerator) callerClass = 'moderator';
  else if (orchestrator) callerClass = 'orchestrator';
  else if (!user?.id) callerClass = 'anonymous';
  else {
    // One id per call: the batch form decides owned Private ids differently. A failed lookup
    // counts as no grant, so `log` still serves and `enforce` withholds. Imported here so the mini
    // route's module graph does not take on common.service.
    const { hasEntityAccess } = await import('~/server/services/common.service');
    const access = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [modelVersionId],
      userId: user.id,
    }).catch(() => []);
    callerClass = access[0]?.hasAccess ? 'grantee' : 'other';
  }

  const wouldRefuse = callerClass === 'anonymous' || callerClass === 'other';
  const withhold = mode === 'enforce' && wouldRefuse;

  logToAxiom({
    type: 'info',
    name: 'mini-epoch-caller',
    modelVersionId,
    authHeader: !!req.headers?.authorization,
    resolvedAs: credentialKind(req, user, orchestrator),
    callerClass,
    wouldRefuse,
    enforced: withhold,
  }).catch(() => undefined);

  return { callerClass, withhold };
}
