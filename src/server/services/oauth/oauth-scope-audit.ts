/**
 * Unified scope-usage audit — the EXTERNAL-OAuth arm.
 *
 * App-Block block-tokens already record one `BlockScopeInvocation` row per
 * scope-gated call (via `recordScopeInvocation`, fired from the block-scope
 * middleware). External apps instead authenticate with a standard OAuth access
 * token whose scope is verified ONCE, centrally, at the `enforceTokenScope`
 * tRPC middleware (src/server/trpc.ts). That path never recorded an audit row,
 * so external OAuth API usage was invisible to the scope-usage audit.
 *
 * This module closes that gap by emitting into the SAME sink + row shape as the
 * block-token audit — `recordScopeInvocation`, tagged `source: 'external-oauth'`
 * with the acting `oauthClientId` — so there is ONE "which app used which scope,
 * when" record across both token populations (no divergent second format).
 *
 * Discipline mirrors the block path exactly:
 *   - fire-and-forget: a failed audit write must NEVER fail or slow the API call;
 *   - lazy import of the DB-backed service so this module (imported by the hot
 *     `enforceTokenScope` middleware) stays free of eager Prisma/DB init;
 *   - emitted from a SINGLE choke point (enforceTokenScope runs once per tRPC
 *     procedure) so a call records exactly one row.
 */

import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Reverse map: a single `TokenScope` bit → its stable machine name (the enum
 * key, e.g. `ModelsRead`). Built from the enum so it can never drift behind a
 * newly-added bit. Excludes the `None` (0) and `Full` (composite mask) entries —
 * neither is a single capability bit.
 */
const SCOPE_NAME_BY_BIT: Record<number, string> = Object.entries(TokenScope).reduce(
  (acc, [key, value]) => {
    if (key === 'None' || key === 'Full') return acc;
    if (typeof value === 'number' && value > 0) acc[value] = key;
    return acc;
  },
  {} as Record<number, string>
);

/**
 * Map a `TokenScope` bitmask (the value a procedure declares via
 * `.meta({ requiredScope })`, or the implicit `Full` for an unannotated
 * endpoint) to a readable, stable scope string for the audit row.
 *
 *   - `TokenScope.Full`         → `'full'`   (unannotated endpoint / full-access token)
 *   - a single known bit         → its enum key, e.g. `'ModelsRead'`
 *   - anything else (a composite / unknown value) → `'scope:<bitmask>'`
 *     (never throws; the numeric value stays recoverable).
 */
export function tokenScopeToAuditName(bit: number): string {
  if (bit === TokenScope.Full) return 'full';
  return SCOPE_NAME_BY_BIT[bit] ?? `scope:${bit}`;
}

type RequestSubject =
  | { type: 'apiKey'; id: number }
  | { type: 'oauth'; id: string }
  | undefined;

/**
 * Fire-and-forget: record ONE external-OAuth scope invocation, iff the request
 * was authenticated by an external OAuth access token (`subject.type === 'oauth'`)
 * and carries a user. A session/cookie request (`subject === undefined`) or a
 * personal API key (`subject.type === 'apiKey'`) records nothing here — those are
 * not external-app usage. Never throws; a failed audit write is swallowed.
 */
export function maybeRecordOauthScopeUsage(opts: {
  subject: RequestSubject;
  userId: number | undefined;
  /** The `TokenScope` bit the call exercised (declared requiredScope, or Full). */
  scopeBit: number;
  /** The route — the tRPC procedure path (dotted name). */
  endpoint: string;
  statusCode: number;
}): void {
  if (opts.subject?.type !== 'oauth' || opts.userId == null) return;
  const oauthClientId = opts.subject.id;
  const userId = opts.userId;
  const scope = tokenScopeToAuditName(opts.scopeBit);
  const endpoint = opts.endpoint;
  const statusCode = opts.statusCode;
  // Lazy import so trpc.ts (which statically imports THIS module) doesn't eager
  // load user-app-surface.service → dbWrite/Prisma init. Mirrors the block path.
  void import('~/server/services/blocks/user-app-surface.service')
    .then(({ recordScopeInvocation }) =>
      recordScopeInvocation({
        userId,
        oauthClientId,
        scope,
        endpoint,
        statusCode,
        source: 'external-oauth',
      })
    )
    .catch(() => {
      /* best-effort — the audit pipeline must never affect the API call */
    });
}
