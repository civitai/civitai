import { createHmac } from 'node:crypto';
import { env } from '~/env/server';
import { withholdsModerator, type BearerCredential } from '~/server/auth/full-user-credential';
import { logToAxiom } from '~/server/logging/client';
import { hasScope, TokenScope } from '~/shared/constants/token-scope.constants';
import type { Session } from '~/types/session';
import { routeSegments, type RouteQuery } from '~/server/utils/route-segments';

/**
 * The token scope a caller needs for the session to be returned to it. Omitted, a bearer credential
 * must hold every bit of `TokenScope.Full`. A browser session always passes.
 * - `{ scope }` / `{ anyOf }`: the credential must hold that bit, or one of them.
 * - `defer`: a later per-operation check decides (tRPC's `enforceTokenScope`).
 * - `selfGated`: the route checks its own scope after resolving; any non-empty scope passes here.
 * - `anyScope`: any bearer credential, including one with no scope bits.
 */
export type SessionScope =
  | { scope: bigint }
  | { anyOf: readonly bigint[] }
  | 'defer'
  | 'selfGated'
  | 'anyScope';

type RestScopeEnforcement = 'off' | 'report' | 'enforce';

type ScopeContext = BearerCredential & {
  apiKeyId?: number | null;
  scopeDecisionsLogged?: Set<string>;
};
type ScopeRequest = { url?: string; query?: RouteQuery; context?: Record<string, unknown> };

export const INSUFFICIENT_SCOPE_MESSAGE =
  'Your API key does not have the required scope for this action';

function credentialMeetsScope(tokenScope: bigint, scope: SessionScope | undefined): boolean {
  if (scope === 'defer' || scope === 'anyScope') return true;
  if (scope === 'selfGated') return tokenScope !== TokenScope.None;
  if (scope === undefined) return hasScope(tokenScope, TokenScope.Full);
  const required = 'scope' in scope ? [scope.scope] : scope.anyOf;
  // `hasScope(x, 0n)` is true for every x, so a zero bit never satisfies a requirement.
  return required.some((bit) => bit !== TokenScope.None && hasScope(tokenScope, bit));
}

/** The recorded scope as a bigint; a number from an older writer is read as one, anything else as no bits. */
function heldScope(tokenScope: unknown): bigint {
  if (typeof tokenScope === 'bigint') return tokenScope;
  if (typeof tokenScope === 'number' && Number.isSafeInteger(tokenScope)) return BigInt(tokenScope);
  return TokenScope.None;
}

function requiredBits(scope: SessionScope | undefined): bigint {
  if (scope === undefined) return TokenScope.Full;
  if (typeof scope === 'string') return TokenScope.None;
  return 'scope' in scope ? scope.scope : scope.anyOf.reduce((all, bit) => all | bit, 0n);
}

const WORD_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;
const HEX_SEGMENT = /^[0-9a-f]+$/;

/**
 * The route template, e.g. `/api/download/models/[modelVersionId]`: a segment Next matched to a
 * route param (`routeSegments`) is logged as the param's name. Any other segment is logged as
 * `:segment` unless it is a short lowercase word, not all hex, that is not also a query-string
 * value. Without `query`, a short lowercase segment such as a slug is logged as it is.
 */
function routeTemplate(url: string | undefined, query: RouteQuery | undefined): string | null {
  if (!url) return null;
  const route = routeSegments(url, query);
  if (!route) return null;
  const logged: string[] = [];
  for (const { value, param, inQueryString } of route.segments) {
    const segment = param
      ? param.catchAll
        ? `[...${param.name}]`
        : `[${param.name}]`
      : !inQueryString && WORD_SEGMENT.test(value) && !HEX_SEGMENT.test(value)
      ? value
      : ':segment';
    // A catch-all param spans several segments; log it once.
    if (param?.catchAll && logged.at(-1) === segment) continue;
    logged.push(segment);
  }
  return `/${logged.join('/')}`;
}

/** Keyed, so the log cannot be mapped back to a key id by hashing the small id range. */
function apiKeyIdHash(apiKeyId: number | null | undefined): string | null {
  if (apiKeyId == null) return null;
  return createHmac('sha256', env.NEXTAUTH_SECRET)
    .update(String(apiKeyId))
    .digest('hex')
    .slice(0, 16);
}

function logScopeDecision(
  req: ScopeRequest,
  context: ScopeContext,
  scope: SessionScope | undefined,
  enforcement: RestScopeEnforcement,
  outcome: 'refused' | 'moderator-withheld',
  query: RouteQuery | undefined = req.query
) {
  const route = routeTemplate(req.url, query);
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
    requiredScope: Number(requiredBits(scope)),
    tokenScope: context.tokenScope == null ? null : Number(context.tokenScope),
    apiKeyType: context.apiKeyType ?? null,
    clientId: context.subject?.type === 'oauth' ? String(context.subject.id) : null,
    payload: {
      outcome,
      scopeKind,
      apiKeyIdHash: apiKeyIdHash(context.apiKeyId),
    },
  });
}

type ScopedSession = { session: Session | null; insufficient: boolean };

/**
 * Holds a bearer credential to `scope`. Reads the credential `getServerAuthSession` recorded on
 * `req.context`; a request with none there (a browser session, or no session) is returned as is.
 * Under `report` the decision is only logged. `query`, when given, names the route params for the
 * log in place of `req.query` (a page request's params are on its context).
 */
export function applySessionScope(
  req: ScopeRequest,
  session: Session | null,
  scope: SessionScope | undefined,
  query?: RouteQuery
): ScopedSession {
  const pass = { session, insufficient: false };
  const user = session?.user;
  const context = req.context as ScopeContext | undefined;
  if (!user || context?.tokenScope == null) return pass;
  const enforcement = env.REST_SCOPE_ENFORCE;
  if (enforcement === 'off') return pass;

  const allowed = credentialMeetsScope(heldScope(context.tokenScope), scope);
  const withholdModerator = allowed && scope !== 'defer' && withholdsModerator(user, context);
  if (!allowed) logScopeDecision(req, context, scope, enforcement, 'refused', query);
  else if (withholdModerator)
    logScopeDecision(req, context, scope, enforcement, 'moderator-withheld', query);
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
  if (enforcement === 'off' || credentialMeetsScope(heldScope(context.tokenScope), scope))
    return true;
  logScopeDecision(req, context, scope, enforcement, 'refused');
  return enforcement !== 'enforce';
}
