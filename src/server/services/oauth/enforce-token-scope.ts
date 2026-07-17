/**
 * `enforceTokenScope` middleware body — extracted from `~/server/trpc` so the
 * OAuth scope-verification + unified scope-usage audit wiring is unit-testable
 * WITHOUT booting the full tRPC pipeline (prom-client / redis / serializer
 * module-load side effects). `trpc.ts` wraps this in `t.middleware(...)`; this
 * module stays light — its only heavy edge (the audit sink) is behind the
 * lazy import inside `maybeRecordOauthScopeUsage`.
 *
 * Properties this locks (a refactor could otherwise silently break them):
 *   - a scope-DENIED call throws BEFORE any emit → records nothing;
 *   - an authorized EXTERNAL-OAuth call emits EXACTLY ONE row, AFTER `next()`
 *     settles, with the real outcome status;
 *   - a resolver error still emits exactly one row (then propagates);
 *   - a session / personal-API-key call emits nothing and takes the bare
 *     `next()` path (no extra async frame).
 */

import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { Flags } from '~/shared/utils/flags';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { maybeRecordOauthScopeUsage } from '~/server/services/oauth/oauth-scope-audit';

/**
 * Map a settled procedure outcome to an HTTP-ish status for the audit row.
 * In tRPC v11 a downstream throw surfaces as a resolved `{ ok: false, error }`
 * MiddlewareResult (not a rejection), so `error` is a `TRPCError` we can map to
 * its real status (FORBIDDEN→403, NOT_FOUND→404, …); a genuine rejection (rare —
 * an infra throw the pipeline didn't wrap) maps the thrown value the same way,
 * defaulting to 500. Never throws.
 */
export function auditStatusFromError(error: unknown): number {
  try {
    if (error instanceof TRPCError) return getHTTPStatusCodeFromError(error);
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string') {
      return getHTTPStatusCodeFromError(new TRPCError({ code: code as TRPCError['code'] }));
    }
  } catch {
    /* fall through */
  }
  return 500;
}

/**
 * The `enforceTokenScope` middleware body. Generic over `next()`'s return so it
 * stays transparent to tRPC's MiddlewareResult typing (same shape as
 * `runRecordProcedureDuration`). `meta` is typed structurally (only the two
 * fields read) to avoid a runtime import cycle with `~/server/trpc`.
 */
export function runEnforceTokenScope<T>(opts: {
  ctx: {
    tokenScope: number;
    apiKeyId?: number | null;
    subject?: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string };
    user?: { id: number } | null;
  };
  meta: { requiredScope?: number; blockApiKeys?: boolean } | undefined;
  path: string;
  next: () => Promise<T>;
}): Promise<T> {
  const { ctx, meta, path, next } = opts;

  // blockApiKeys: deny any token-based request, regardless of scope. Session
  // auth (apiKeyId === null) is unaffected. Thrown BEFORE any emit → a denied
  // call records nothing.
  if (meta?.blockApiKeys && ctx.apiKeyId != null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action cannot be performed via API key or OAuth token.',
    });
  }

  // The scope this call exercises — the declared requiredScope, or Full for an
  // unannotated endpoint (which implicitly requires Full). Also the value the
  // external-OAuth scope-usage audit records below.
  const requiredScope = meta?.requiredScope ?? TokenScope.Full;

  // Session auth (cookies) and full-access API keys pass through the scope check;
  // a scoped token must carry the required bit. A scope-denied call throws HERE,
  // before the emit block → it records nothing.
  if (ctx.tokenScope !== TokenScope.Full) {
    if (!Flags.hasFlag(ctx.tokenScope, requiredScope)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Your API key does not have the required scope for this action',
      });
    }
  }

  // Unified scope-usage audit — external-OAuth arm. This is the single central
  // choke point where an OAuth access token's scope is verified, so it's where
  // external OAuth API usage is recorded (mirroring the block-token audit fired
  // from block-scope.middleware). Only an external OAuth token reaches the sink
  // (guarded inside maybeRecordOauthScopeUsage — session + personal-API-key
  // requests emit nothing). Fire-and-forget, emitted AFTER the procedure settles
  // so the status is real + EXACTLY one row per call. We wrap next() only for
  // OAuth subjects so the (dominant) session path stays a bare `next()`.
  if (ctx.subject?.type !== 'oauth' || ctx.user?.id == null) {
    return next();
  }
  const subject = ctx.subject;
  const userId = ctx.user.id;
  return next().then(
    (result) => {
      // tRPC v11: a downstream throw resolves as { ok: false, error }, so derive
      // the real status from the error; a success is 200.
      const r = result as unknown as { ok?: boolean; error?: unknown };
      const statusCode = r?.ok === false ? auditStatusFromError(r.error) : 200;
      maybeRecordOauthScopeUsage({
        subject,
        userId,
        scopeBit: requiredScope,
        endpoint: path,
        statusCode,
      });
      return result;
    },
    (err) => {
      // A genuine rejection (infra throw the pipeline didn't wrap) — still record
      // exactly one row, then re-throw so the error propagates unchanged.
      maybeRecordOauthScopeUsage({
        subject,
        userId,
        scopeBit: requiredScope,
        endpoint: path,
        statusCode: auditStatusFromError(err),
      });
      throw err;
    }
  );
}
