import type { NextApiRequest } from 'next';
import type { Session } from '~/types/session';
import { matchesOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import { getRequestCredential } from '~/server/auth/request-credential';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';

export type MiniEpochGateMode = 'off' | 'log' | 'enforce' | 'enforce-anon';

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
  return variant === 'log' || variant === 'enforce' || variant === 'enforce-anon' ? variant : 'off';
}

export function credentialKind(
  req: NextApiRequest,
  user: Session['user'] | undefined,
  orchestrator: boolean
): MiniEpochCredential {
  if (orchestrator) return 'orchestrator';
  const subject = getRequestCredential(req).subject?.type;
  if (subject === 'oauth') return 'oauth';
  if (subject === 'apiKey') return 'api-key';
  // `?token=` is a credential channel too; one that does not resolve counts as presented.
  if (req.headers?.authorization || requestCarriesQueryToken(req)) return 'unrecognized';
  return user ? 'session' : 'none';
}

/**
 * Whether `userId` holds an EntityAccess grant on the version. One id per call: the batch form
 * decides owned Private ids differently. A failed lookup counts as no grant.
 */
export async function hasVersionGrant(userId: number, modelVersionId: number): Promise<boolean> {
  // Imported here so the mini route's module graph does not take on common.service.
  const { hasEntityAccess } = await import('~/server/services/common.service');
  const access = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: [modelVersionId],
    userId,
  }).catch(() => []);
  return !!access[0]?.hasAccess;
}

/**
 * Classifies the caller of the epoch arm for a Private version, logs it, and answers whether they
 * are refused. `enforce` refuses `anonymous` and `other`; `enforce-anon` refuses only a request
 * that carries no credential at all.
 */
export async function evaluateMiniEpochCaller({
  req,
  user,
  modelVersionId,
  ownerId,
  mode,
  scopeRefused,
  pick,
}: {
  req: NextApiRequest;
  user: Session['user'] | undefined;
  modelVersionId: number;
  ownerId: number;
  mode: Exclude<MiniEpochGateMode, 'off'>;
  /** The bearer credential lacks the route's scope: a signed-in caller is classed `other`. */
  scopeRefused: boolean;
  /** How the training file was chosen: by id, or as the primary file, hidden from the caller or not. */
  pick: 'by-id' | 'primary' | 'hidden-primary';
}): Promise<{ callerClass: MiniEpochCallerClass; withhold: boolean }> {
  const orchestrator = matchesOrchestratorServiceToken(req);

  let callerClass: MiniEpochCallerClass;
  if (user?.id && scopeRefused) callerClass = 'other';
  else if (user?.id && user.id === ownerId) callerClass = 'owner';
  else if (user?.isModerator) callerClass = 'moderator';
  else if (orchestrator) callerClass = 'orchestrator';
  else if (!user?.id) callerClass = 'anonymous';
  else callerClass = (await hasVersionGrant(user.id, modelVersionId)) ? 'grantee' : 'other';

  const resolvedAs = credentialKind(req, user, orchestrator);
  const wouldRefuse = callerClass === 'anonymous' || callerClass === 'other';
  // Keyed on the credential, not on `callerClass`: a bearer that does not resolve is classed
  // `anonymous`, and `enforce-anon` must still serve it.
  const withhold =
    (mode === 'enforce' && wouldRefuse) || (mode === 'enforce-anon' && resolvedAs === 'none');

  logToAxiom({
    type: 'info',
    name: 'mini-epoch-caller',
    mode,
    modelVersionId,
    pick,
    authHeader: !!req.headers?.authorization,
    resolvedAs,
    callerClass,
    wouldRefuse,
    enforced: withhold,
  }).catch(() => undefined);

  return { callerClass, withhold };
}
