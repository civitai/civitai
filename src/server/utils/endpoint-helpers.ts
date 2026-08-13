import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import { isArray } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session, SessionUser } from '~/types/session';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { checkNotUpToDate } from '~/server/db/db-helpers';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { generateSecretHash } from '~/server/utils/key-generator';
import { getAllServerHosts } from '~/server/utils/server-domain';
import type { Partner } from '~/shared/utils/prisma/models';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { isClientAbortError, isDriverAuthoredMessage } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import { logToAxiom, buildCentralErrorLog, wasServerFaultLogged } from '~/server/logging/client';
import {
  GENERIC_CLIENT_ERROR_BY_STATUS,
  GENERIC_SERVER_ERROR_MESSAGE,
  REST_ERROR_CODE,
  restErrorBody,
} from '~/server/utils/rest-error-envelope';

// Fire-and-forget structured, cause-walked error log for a REST 500 produced by
// `handleEndpointError`. logToAxiom's stderr write is synchronous (→ Alloy → Loki),
// so the queryable `_axiom` line lands even though we don't await; the `.catch`
// guarantees telemetry can never break the error response. Server faults carry the
// un-masked `.cause` chain + severity `type:'error'` (queryable as
// detected_level="error"); client-fault 4xx and SERVICE_UNAVAILABLE 503s are gated
// out at the call site so they never hit the error stream.
function logRestServerFault(e: unknown) {
  // Skip if a router/service already logged this exact fault before re-throwing.
  if (wasServerFaultLogged(e)) return;
  logToAxiom({ ...buildCentralErrorLog(e), source: 'handleEndpointError' }, 'civitai-prod').catch(
    () => undefined
  );
}

/**
 * Same log, forced to INFO severity — for a 4xx whose message we genericized.
 *
 * The entry must still be emitted: genericizing is only defensible because it
 * RELOCATES the driver text rather than destroying it. But it must not land on
 * the error board, and one status makes that concrete rather than theoretical.
 *
 * 🔴 The only Prisma codes that reach **408** are `P1008` / `P2024` — connection
 * pool exhaustion. That is wave-shaped: during an incident every affected public
 * request would add an error-severity line, on routes that previously logged
 * nothing at all. It is the same "fires in high-volume waves" property for which
 * `isRestServerFault` excludes 503 from the error stream.
 *
 * `classifyErrorFault` treats `TIMEOUT` as a SERVER fault, and that is correct
 * for the repo at large (a timeout usually IS ours), so this does NOT change the
 * global classification — it overrides `type`/`level` for this arm only. `type`
 * is the load-bearing field: Alloy extracts it into Loki's `detected_level`.
 *
 * 400/404/409 already classify as client faults, so for those this is a no-op and
 * the uniform treatment is the point — "a genericized 4xx is logged for forensics,
 * never as an incident" is one rule rather than three.
 */
function logRestGenericizedClientFault(e: unknown) {
  if (wasServerFaultLogged(e)) return;
  logToAxiom(
    { ...buildCentralErrorLog(e), type: 'info', level: 'info', source: 'handleEndpointError' },
    'civitai-prod'
  ).catch(() => undefined);
}

/**
 * Is this REST status a SERVER FAULT — i.e. one whose error text is OURS, never a
 * message written for the caller?
 *
 * 🔴 ONE predicate, deliberately governing BOTH sides of `handleEndpointError`:
 * whether the fault is LOGGED in full, and whether the response body is
 * GENERICIZED. Keeping them on one rule buys an invariant that is worth more than
 * either half alone, and that `endpoint-helpers-error-envelope.test.ts` pins over
 * every 5xx status:
 *
 *   the un-redacted text is dropped from the wire EXACTLY when it is preserved in
 *   the log — so genericizing can never destroy the only copy of a message.
 *
 * Two exclusions, both load-bearing:
 *   - **4xx** is *usually* client feedback the caller is meant to read (zod
 *     issues, "not found", rate-limit hints), so it is not a server fault and is
 *     not genericized HERE.
 *
 *     🔴 That used to be stated without the "usually", and as written it was
 *     FALSE — civitai#3845 investigation 3. `throwDbError` maps a large slice of
 *     Prisma codes to 4xx (P2000→400, P2025→404, P2003→409, P2024→408) while
 *     copying the driver's own `message` verbatim, so a 4xx body could be a raw
 *     `Invalid \`prisma.<model>.<method>()\` invocation` dump disclosing the table,
 *     the column or the constraint name. Those are now caught by a SECOND
 *     predicate, `isDriverAuthoredMessage`, applied inside the 4xx arm below: it
 *     asks who WROTE the text rather than how severe the status is, keeps the
 *     status, and — crucially — logs the un-redacted text on the way out, so the
 *     "genericized exactly when logged" invariant holds for it too. A 4xx whose
 *     message is ours is still passed through byte-identically.
 *   - **503** is the retryable transient-upstream mapping
 *     (`throwServiceUnavailableError`, the Meili/ClickHouse/orchestrator brownout
 *     guards). It fires in high-volume waves, so it is excluded from the error
 *     stream — which means the response is the ONLY copy of its message. Its
 *     messages are hand-authored retry hints ("… is temporarily overloaded —
 *     please retry."), and no Prisma code maps to SERVICE_UNAVAILABLE in
 *     `prismaErrorToTrpcCode`, so the #3845 disclosure class cannot arrive as a
 *     503. Genericizing it would therefore destroy an actionable hint (the
 *     shipped Go CLI renders it verbatim on its 503 branch) to redact text that
 *     is never driver-derived. Kept verbatim, on purpose.
 *
 * NB `TIMEOUT` maps to **408**, not a 5xx (`@trpc/server` JSONRPC2_TO_HTTP_CODE),
 * so it takes the 4xx pass-through. The 5xx codes reachable here are
 * INTERNAL_SERVER_ERROR (500), NOT_IMPLEMENTED (501), BAD_GATEWAY (502),
 * SERVICE_UNAVAILABLE (503) and GATEWAY_TIMEOUT (504).
 */
function isRestServerFault(status: number): boolean {
  return status >= 500 && status !== 503;
}

/**
 * Mark an error response uncacheable. Applied to EVERY response this helper
 * writes — there is no such thing as an error worth serving from a shared cache.
 *
 * 🔴 `PublicEndpoint` sets `Cache-Control: public, s-maxage=300,
 * stale-while-revalidate=150` on EVERY response, unconditionally, BEFORE the
 * handler runs — errors included. That was survivable while every failure on
 * those routes was a 5xx, because shared caches do not cache 5xx by default. It
 * stops being survivable the moment an error answers **404**: 404 IS in the
 * default cacheable set, so a `NOT_FOUND` from a transient condition (replica
 * lag, a `throwDbError`-mapped P2001/P2025) would be pinned at the edge for 300s
 * + 150s SWR — serving "no such thing" for five minutes after the thing exists.
 *
 * 🔴 **An earlier version of this scoped the opt-out to the GENERICIZED arms, and
 * that missed the case it was written for.** Measured, per arm, against a `res`
 * pre-stamped with `PublicEndpoint`'s header:
 *
 *   pass-through 404 (`throwNotFoundError`)  →  public, s-maxage=300   ← the hazard
 *   non-TRPCError 500 (else-branch)          →  public, s-maxage=300
 *   genericized 5xx                          →  no-store
 *
 * The routes this change touches answer 404 mostly via `throwNotFoundError`,
 * whose message is OURS — so it takes the pass-through arm and never reached the
 * genericized one. Scoping by "did we rewrite the body" was the wrong axis; the
 * right axis is "is this a response a cache should keep", and for an error the
 * answer is always no.
 *
 * **Accepted trade:** a 404 flood (scrapers hitting bad slugs) now reaches the
 * origin instead of being absorbed at the edge for 5 minutes. Correctness on a
 * transient 404 is worth more than cache efficiency on an error path, and these
 * routes are not the ones under that kind of load. Stated so the next person
 * knows it was a decision, not an oversight.
 *
 * Uniform application also removes a **fault-classification oracle**: with the
 * narrower version, `no-store` vs `s-maxage=300` on the same status told a caller
 * whether the message had been rewritten — one bit of exactly the kind the 5xx
 * arm's own comment says genericizing exists to remove.
 *
 * `v1/users/index.ts` and `v1/images/index.ts` already do this at their 503 arms.
 * They emit bare `no-store` where this emits `no-store, max-age=0`; both are
 * correct, and their tests pin the exact string, so they are left alone.
 */
function noStore(res: NextApiResponse) {
  if (!res.headersSent) res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res;
}

type AxiomAPIRequest = NextApiRequest & { log: Logger };

// Single chokepoint every endpoint wrapper funnels through (in place of a bare
// `withAxiom`). Records a `civitai_app_http_errors_total` sample for any 5xx
// response — however it's produced — by attaching one `finish` listener. Steady-
// state cost is one listener registration + an int compare; the route
// normalization runs only on 5xx. See src/server/prom/http-errors.ts.
function withApiMetrics(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void | NextApiResponse>
) {
  return withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    instrumentApiResponse(req, res);
    // `await` without returning so this closure is Promise<void> — withAxiom's
    // AxiomApiHandler overload requires that, and withAxiom already discards a
    // handler's return value (same shape the 6 wrappers below rely on).
    await handler(req, res);
  });
}

export function TokenSecuredEndpoint(
  token: string,
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (req.query.token !== token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await handler(req, res);
  });
}

export function JobEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return TokenSecuredEndpoint(env.JOB_TOKEN, handler);
}

export function WebhookEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void>
) {
  return TokenSecuredEndpoint(env.WEBHOOK_TOKEN, handler);
}

const PUBLIC_CACHE_MAX_AGE = 300;

const allowedOrigins = [env.NEXTAUTH_URL, ...env.TRPC_ORIGINS, ...getAllServerHosts()]
  .filter(isDefined)
  .map((origin) => {
    if (!origin.startsWith('http')) return `https://${origin}`;
    return origin;
  });
export const addCorsHeaders = (
  req: NextApiRequest,
  res: NextApiResponse,
  allowedMethods: string[] = ['GET'],
  { allowCredentials = false }: { allowCredentials?: boolean } = {}
) => {
  if (allowCredentials) {
    const origin = req.headers.origin;
    const allowedOrigin = allowedOrigins.find((o) => origin?.startsWith(o)) ?? allowedOrigins[0];
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
};

const addPublicCacheHeaders = (
  req: NextApiRequest,
  res: NextApiResponse,
  maxAge: number = PUBLIC_CACHE_MAX_AGE
) => {
  const staleWhileRevalidate = Math.floor(maxAge / 2);
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
};

export function PublicEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET'],
  // Optional per-endpoint edge cache max-age (seconds). Defaults to PUBLIC_CACHE_MAX_AGE
  // so every existing caller is unchanged. Endpoints whose results are near-immutable
  // (e.g. by-hash model-version lookups) can opt into a longer TTL.
  { maxAge }: { maxAge?: number } = {}
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    const shouldStop = addCorsHeaders(req, res, allowedMethods);
    addPublicCacheHeaders(req, res, maxAge);
    if (shouldStop) return;
    await handler(req, res);
  });
}

export function AuthedEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: SessionUser
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    const shouldStop = addCorsHeaders(req, res, allowedMethods, { allowCredentials: true });
    if (shouldStop) return;

    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    const session = await getServerAuthSession({ req, res });
    if (!session?.user) return res.status(401).json({ error: 'Unauthorized' });
    await handler(req, res, session.user);
  });
}

export function MixedAuthEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: Session['user'] | undefined
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    const shouldStop = addCorsHeaders(req, res, allowedMethods);
    const session = await getServerAuthSession({ req, res });
    if (!session) addPublicCacheHeaders(req, res);
    if (shouldStop) return;

    if (!!req.query?.etag && req.query.etag !== '') {
      const isNotUpToDate = await checkNotUpToDate(
        isArray(req.query.etag) ? req.query.etag[0] : req.query.etag
      );
      // logToAxiom({
      //   name: 'etag-stuff',
      //   type: 'info',
      //   data: {
      //     url: req.url,
      //     etag: req.query.etag,
      //     isNotUpToDate,
      //     expiresHeader: dayjs().add(1, 'minute').toISOString(),
      //   },
      // }).catch();
      if (isNotUpToDate) {
        res.setHeader('X-Expires', dayjs().add(1, 'minute').toISOString());
      }
    }

    await handler(req, res, session?.user);
  });
}

export function PartnerEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse, partner: Partner) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (!req.query.token || Array.isArray(req.query.token))
      return res.status(401).json({ error: 'Unauthorized' });
    const token = generateSecretHash(req.query.token);
    const partner = await dbRead.partner.findUnique({ where: { token } });
    if (!partner) return res.status(401).json({ error: 'Unauthorized', message: 'Bad token' });

    await handler(req, res, partner);
  });
}

export function ModEndpoint(
  handler: (req: AxiomAPIRequest, res: NextApiResponse, user: SessionUser) => Promise<void>,
  allowedMethods: string[] = ['GET']
) {
  return withApiMetrics(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method)) {
      res.setHeader('Allow', allowedMethods);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const session = await getServerAuthSession({ req, res });
    if (!session || !session.user?.isModerator || !!session.user.bannedAt)
      return res.status(401).json({ error: 'Unauthorized' });

    await handler(req, res, session.user);
  });
}

export function handleEndpointError(res: NextApiResponse, e: unknown) {
  if (isClientAbortError(e)) {
    // Client disconnected mid-request (closed tab / scrolled the feed past /
    // navigated away), cancelling the request signal. Not a server fault: respond
    // 499 (client closed request) so it stays out of the 5xx SLO + the
    // civitai_app_http_errors_total counter and isn't logged as a spurious 500.
    if (!res.headersSent) noStore(res).status(499).end();
    return;
  }
  if (e instanceof TRPCError) {
    const apiError = e as TRPCError;
    const status = getHTTPStatusCodeFromError(apiError);
    // ── SERVER FAULT (500/501/502/504) — log in full, genericize on the wire ────
    // A TRPCError that maps to one of these is a genuine server fault that
    // previously reached the client as a 5xx with NOTHING logged structurally —
    // invisible in `_axiom`. Emit the un-masked cause-walked error log so it's
    // queryable. See `isRestServerFault` for why 4xx and 503 are excluded.
    //
    // 🔴 civitai#3845 — this branch produces 500s TOO, and its body was the SAME
    // leak the else-branch below had. `throwDbError` (~310 call sites) turns a
    // driver error straight into
    //   `new TRPCError({ code: prismaErrorToTrpcCode[e.code] ?? 'INTERNAL_SERVER_ERROR',
    //                    message: e.message, cause: e })`
    // and `P2022` — the exact code from the #3845 incident — maps to
    // INTERNAL_SERVER_ERROR, so the raw invocation text carrying the TABLE and
    // COLUMN name arrived here and was served verbatim (the fallback body below
    // is `{ message: apiError.message }`). Reachable unauthenticated: e.g.
    // `GET /api/v1/articles/{id}` (a public MixedAuthEndpoint) → `getArticleById`
    // → `throwDbError`. Genericizing here is what makes "no driver-derived text on
    // any 500" a property of the HELPER rather than of one branch of it.
    //
    // The `code` is deliberately UNIFORM across every genericized 5xx: the HTTP
    // status already distinguishes 500/501/502/504, and a per-sub-kind code would
    // hand back a fault-classification oracle that genericizing exists to remove.
    // The un-redacted error is fully preserved by `logRestServerFault` above —
    // this genericizes the RESPONSE only, never the LOG.
    if (isRestServerFault(status)) {
      logRestServerFault(apiError);
      return noStore(res)
        .status(status)
        .json(restErrorBody(REST_ERROR_CODE.INTERNAL_SERVER_ERROR, GENERIC_SERVER_ERROR_MESSAGE));
    }
    // ── DRIVER-AUTHORED 4xx — status kept, MESSAGE genericized ────────────────
    // 🔴 civitai#3845 investigation 3. The arm below this one is correct for a
    // message we wrote and wrong for one Postgres wrote. `throwDbError` forwards
    // the driver's `message` verbatim and `prismaErrorToTrpcCode` sends a large
    // slice of codes to 4xx, so `P2000 → 400` shipped the offending COLUMN,
    // `P2003 → 409` the CONSTRAINT name and `P2025 → 404` the model + method.
    //
    // The discriminator is message IDENTITY against a driver error in the cause
    // chain — NOT "is a driver error present". The chain test has a real false
    // positive: `throwBadRequestError('That slug is already taken', dbError)`
    // attaches the driver as `cause` while writing a message FOR the caller, and
    // genericizing that would destroy good client feedback to redact nothing.
    //
    // Logged BEFORE genericizing, on purpose: this arm buys into exactly the same
    // invariant as the 5xx arm — the un-redacted text leaves the wire precisely
    // when it enters the log, so no message is ever destroyed outright.
    //
    // 503 needs no explicit exclusion here: `GENERIC_CLIENT_ERROR_BY_STATUS` has
    // no 503 key, so `generic` is already undefined for it, and
    // `rest-error-envelope-ledger.test.ts` FAILS if a 503 key is ever added
    // (its key set must equal the 4xx statuses `prismaErrorToTrpcCode` reaches).
    // An earlier draft carried a `status !== 503` clause; it was dead — removing
    // it left the whole suite green — and a test comment claimed it was what
    // enforced the exclusion, which was false. The map's key set is.
    const generic = GENERIC_CLIENT_ERROR_BY_STATUS[status];
    if (generic && isDriverAuthoredMessage(apiError.message, apiError)) {
      logRestGenericizedClientFault(apiError);
      return noStore(res).status(status).json(restErrorBody(generic.code, generic.message));
    }
    // ── CLIENT FEEDBACK (4xx) + 503 — passed through BYTE-IDENTICALLY ──────────
    // Older Zod-validation TRPCErrors stuff a JSON-encoded issue array into
    // `message`; many newer call sites (incl. `withMeili`'s
    // MeiliCallTimeoutError → TRPCError mapping) pass a plain string. Falling
    // through to JSON.parse on a plain string throws SyntaxError, escapes
    // uncaught, and turns a transient 408/503 into a Next.js default 500 —
    // the opposite of fail-fast. Try the parse, fall back to a one-shot
    // { message } envelope on failure.
    let body: unknown;
    try {
      body = JSON.parse(apiError.message);
    } catch {
      body = { message: apiError.message };
    }
    return noStore(res).status(status).json(body);
  } else {
    const error = e as Error;
    // This branch increments the http-errors counter (via the wrapper's
    // instrumentApiResponse) but historically logged nothing structural, so any
    // non-TRPCError throw inside a wrapped handler — e.g. an unguarded TypeError —
    // was counted yet completely un-attributable in logs (it took a live repro to
    // find one such silent 500). Emit the structured, cause-walked `_axiom` error
    // log (name + message + stack, un-masked cause) so the next one is attributable
    // from Loki the normal way. safeError keeps it PII-light (primitive fields only).
    logRestServerFault(error);
    // 🔴 civitai#3845 — do NOT put `error.message` (or any other driver-derived
    // text) in this body. `handleEndpointError` is the shared 500 chokepoint for
    // 14 REST routes — 10 on the public `/api/v1` surface, plus 3 `mod/*` and
    // `user/orchestrator-key`, which are authenticated — and this is ONE of its
    // two 500-producing branches (the TRPCError branch above is the other, and
    // had the same leak). `.message` here is whatever the driver produced. In the
    // #3845 incident that was a raw Prisma invocation carrying the TABLE and
    // COLUMN name, served to unauthenticated callers on `GET /api/v1/apps/{slug}`:
    //   "Invalid `prisma.appCollaborator.findMany()` invocation: The column
    //    `app_collaborators.app_listing_id` does not exist in the current database."
    // The un-redacted error is still fully preserved by `logRestServerFault`
    // above (structured, cause-walked, queryable in `_axiom`) — this genericizes
    // the RESPONSE only, never the LOG. Pinned by
    // `src/server/utils/__tests__/endpoint-helpers-error-envelope.test.ts`.
    return noStore(res)
      .status(500)
      .json(restErrorBody(REST_ERROR_CODE.INTERNAL_SERVER_ERROR, GENERIC_SERVER_ERROR_MESSAGE));
  }
}

export function OrchestratorEndpoint(
  handler: (
    req: AxiomAPIRequest,
    res: NextApiResponse,
    user: SessionUser,
    token: string
  ) => Promise<void | NextApiResponse>,
  allowedMethods: string[] = ['GET']
) {
  return AuthedEndpoint(async (req, res, user) => {
    const token = await getOrchestratorToken(user.id, { req, res });
    return await handler(req, res, user, token);
  }, allowedMethods);
}
