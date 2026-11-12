import type { NextApiRequest } from 'next';
import { isFullScopeUserKey, type BearerCredential } from '~/server/auth/full-user-credential';
import { credentialLogFields, getRequestCredential } from '~/server/auth/request-credential';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { countDownloadScopeRefused } from '~/server/prom/download-scope.metrics';
import { matchWebhookToken } from '~/server/utils/webhook-token';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export type DownloadScopeMode = 'off' | 'log' | 'enforce';
export type DownloadRoute =
  | '/api/download/models/[modelVersionId]'
  | '/api/download/sha256/[hash]'
  | '/api/download/blake3/[hash]'
  | '/api/download/attachments/[fileId]'
  | '/api/download/vault/[vaultItemId]'
  | '/api/v1/model-versions/mini/[id]';

export const DOWNLOAD_SCOPE_REFUSED = {
  error: 'Your API key does not have the required scope for this action',
};

type Context = BearerCredential & { apiKeyId?: number | null };
type Requirement = { requiredScope: number } | { anyOfScopes: number[] };

export async function getDownloadScopeGateMode(): Promise<DownloadScopeMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.DOWNLOAD_SCOPE_GATE);
  return variant === 'log' || variant === 'enforce' ? variant : 'off';
}

/**
 * Whether the request carried a bearer credential: the header, a `?token=` the session layer
 * reads as one, or any credential field it recorded. A request whose context was not populated
 * still counts, so it is never mistaken for a cookie session.
 */
function presentedBearer(req: NextApiRequest, context: Context | undefined): boolean {
  if (req.headers?.authorization) return true;
  const queryToken = req.url ? new URL(req.url, 'http://local').searchParams.get('token') : null;
  if (queryToken && !matchWebhookToken(queryToken)) return true;
  return (
    context?.apiKeyId != null ||
    context?.apiKeyType != null ||
    context?.subject != null ||
    context?.tokenScope != null
  );
}

/**
 * The bearer credential on a download request, checked against the route's scope. Reads
 * `req.context`, so it must run after `getServerAuthSession`.
 *
 * - `session`: no bearer credential (a cookie session, or anonymous).
 * - `allowed`: a full-scope credential, or one carrying a required scope.
 * - `refused`: anything else, including a bearer whose recorded scope is missing.
 *
 * `effectiveUser` is the user to authorize with: moderator rights come only from a cookie session
 * or a full-scope personal key, whatever the scope check says.
 */
export function downloadCredentialGate(
  req: NextApiRequest,
  user: SessionUser | undefined,
  requirement: Requirement
): { outcome: 'session' | 'allowed' | 'refused'; effectiveUser: SessionUser | undefined } {
  const context = (req as NextApiRequest & { context?: Context }).context;
  if (!presentedBearer(req, context)) return { outcome: 'session', effectiveUser: user };

  const effectiveUser =
    user && user.isModerator && !isFullScopeUserKey(context)
      ? { ...user, isModerator: false }
      : user;
  const scope = context?.tokenScope;
  const required =
    'requiredScope' in requirement ? [requirement.requiredScope] : requirement.anyOfScopes;
  const allowed =
    typeof scope === 'number' &&
    (scope === TokenScope.Full || required.some((bit) => Flags.hasFlag(scope, bit)));
  return { outcome: allowed ? 'allowed' : 'refused', effectiveUser };
}

/**
 * The rollout mode for a request `downloadCredentialGate` refused. Under `log` and `enforce` the
 * refusal is logged and counted.
 */
export async function scopeRefusalMode(
  req: NextApiRequest,
  route: DownloadRoute,
  requirement: Requirement
): Promise<DownloadScopeMode> {
  const mode = await getDownloadScopeGateMode().catch((): DownloadScopeMode => 'off');
  if (mode === 'off') return mode;
  const context = (req as NextApiRequest & { context?: Context }).context;
  const fields = credentialLogFields(getRequestCredential(req));
  countDownloadScopeRefused(route, fields.apiKeyType ?? 'none', mode);
  // No token, user, email or address.
  logToAxiom({
    name: 'download-scope-refused',
    type: 'info',
    mode,
    route,
    requiredScope:
      'requiredScope' in requirement
        ? requirement.requiredScope
        : requirement.anyOfScopes.reduce((all, bit) => all | bit, 0),
    ...fields,
    tokenScope: context?.tokenScope ?? null,
    apiKeyId: context?.apiKeyId ?? null,
  }).catch(() => undefined);
  return mode;
}

/** `downloadCredentialGate`, plus its rollout flag: `refuse` is true only under `enforce`. */
export async function checkDownloadCredential(
  req: NextApiRequest,
  user: SessionUser | undefined,
  { route, ...requirement }: { route: DownloadRoute } & Requirement
) {
  const gate = downloadCredentialGate(req, user, requirement);
  const refuse =
    gate.outcome === 'refused' && (await scopeRefusalMode(req, route, requirement)) === 'enforce';
  return { ...gate, refuse };
}
