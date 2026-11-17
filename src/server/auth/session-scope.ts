import { createHash } from 'node:crypto';
import { env } from '~/env/server';
import { isFullScopeUserKey, type BearerCredential } from '~/server/auth/full-user-credential';
import { constants } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import type { Session } from '~/types/session';

/**
 * The token scope a caller needs for the session to be returned to it. Omitted, a bearer credential
 * must hold every bit of `TokenScope.Full`. A browser session always passes.
 * - `{ scope }` / `{ anyOf }`: the credential must hold that bit, or one of them.
 * - `defer`: a later per-operation check decides (tRPC's `enforceTokenScope`).
 * - `selfGated`: the route checks its own scope after resolving; any non-empty scope passes here.
 * - `anyScope`: any bearer credential, including one with no scope bits.
 */
export type SessionScope =
  | { scope: number }
  | { anyOf: readonly number[] }
  | 'defer'
  | 'selfGated'
  | 'anyScope';

export type RestScopeEnforcement = 'off' | 'report' | 'enforce';

type ScopeContext = BearerCredential & {
  apiKeyId?: number | null;
  scopeDecisionsLogged?: Set<string>;
};
type ScopeRequest = { url?: string; context?: Record<string, unknown> };

export const INSUFFICIENT_SCOPE_MESSAGE =
  'Your API key does not have the required scope for this action';

export function credentialMeetsScope(tokenScope: number, scope: SessionScope | undefined): boolean {
  if (scope === 'defer' || scope === 'anyScope') return true;
  if (scope === 'selfGated') return tokenScope !== TokenScope.None;
  if (scope === undefined) return Flags.hasFlag(tokenScope, TokenScope.Full);
  const required = 'scope' in scope ? [scope.scope] : scope.anyOf;
  // `hasFlag(x, 0)` is true for every x, so a zero bit never satisfies a requirement.
  return required.some((bit) => bit !== TokenScope.None && Flags.hasFlag(tokenScope, bit));
}

/** Moderator rights reach a bearer credential only through a full-scope personal key. */
function withholdsModerator(user: NonNullable<Session['user']>, context: ScopeContext) {
  if (!user.isModerator || isFullScopeUserKey(context)) return false;
  // The internal system account's keys are limited to read scopes and keep its rights by id.
  return !(user.id === constants.system.user.id && context.subject?.type === 'apiKey');
}

function requiredBits(scope: SessionScope | undefined): number {
  if (scope === undefined) return TokenScope.Full;
  if (typeof scope === 'string') return TokenScope.None;
  return 'scope' in scope ? scope.scope : scope.anyOf.reduce((all, bit) => all | bit, 0);
}

function logScopeDecision(
  req: ScopeRequest,
  context: ScopeContext,
  scope: SessionScope | undefined,
  enforcement: RestScopeEnforcement,
  outcome: 'refused' | 'moderator-withheld'
) {
  const route = req.url?.split('?')[0] ?? null;
  const scopeKind =
    scope === undefined ? 'full' : typeof scope === 'string' ? scope : Object.keys(scope)[0];
  const key = `${route} ${scopeKind} ${requiredBits(scope)} ${outcome}`;
  const logged = (context.scopeDecisionsLogged ??= new Set());
  if (logged.has(key)) return;
  logged.add(key);
  // No user, address, key or token.
  logToAxiom({
    name: 'rest-scope-decision',
    type: 'info',
    mode: enforcement,
    route,
    requiredScope: requiredBits(scope),
    tokenScope: context.tokenScope ?? null,
    apiKeyType: context.apiKeyType ?? null,
    clientId: context.subject?.type === 'oauth' ? String(context.subject.id) : null,
    payload: {
      outcome,
      scopeKind,
      apiKeyIdHash:
        context.apiKeyId != null
          ? createHash('sha256').update(String(context.apiKeyId)).digest('hex').slice(0, 16)
          : null,
    },
  });
}

export type ScopedSession = { session: Session | null; insufficient: boolean };

/**
 * Holds a bearer credential to `scope`. Reads the credential `getServerAuthSession` recorded on
 * `req.context`; a request with none there (a browser session, or no session) is returned as is.
 * Under `report` the decision is only logged.
 */
export function applySessionScope(
  req: ScopeRequest,
  session: Session | null,
  scope: SessionScope | undefined
): ScopedSession {
  const pass = { session, insufficient: false };
  const user = session?.user;
  const context = req.context as ScopeContext | undefined;
  if (!user || context?.tokenScope == null) return pass;
  const enforcement = env.REST_SCOPE_ENFORCE;
  if (enforcement === 'off') return pass;

  const allowed = credentialMeetsScope(context.tokenScope, scope);
  const withholdModerator = allowed && scope !== 'defer' && withholdsModerator(user, context);
  if (!allowed) logScopeDecision(req, context, scope, enforcement, 'refused');
  else if (withholdModerator)
    logScopeDecision(req, context, scope, enforcement, 'moderator-withheld');
  if (enforcement === 'report') return pass;

  if (!allowed) return { session: null, insufficient: true };
  if (withholdModerator)
    return { session: { ...session, user: { ...user, isModerator: false } }, insufficient: false };
  return pass;
}

/**
 * Whether the request's credential holds `scope`, with the same enforcement setting as
 * `applySessionScope`: true for a browser session, and always true unless enforcing.
 */
export function requestHoldsScope(req: ScopeRequest, scope: SessionScope): boolean {
  const context = req.context as ScopeContext | undefined;
  if (context?.tokenScope == null) return true;
  const enforcement = env.REST_SCOPE_ENFORCE;
  if (enforcement === 'off' || credentialMeetsScope(context.tokenScope, scope)) return true;
  logScopeDecision(req, context, scope, enforcement, 'refused');
  return enforcement !== 'enforce';
}
