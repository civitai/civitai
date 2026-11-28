import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { refuseModerationAccountSession } from '~/server/auth/moderation-account';
import { isFullScopeUserKey, type BearerCredential } from '~/server/auth/full-user-credential';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from '~/server/clickhouse/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  FULL_SCOPE_SESSION_REQUIRED,
  isFullScopeSession,
} from '~/server/utils/require-full-scope-session';
import type { SessionUser } from '~/types/session';

// MODERATOR ENDPOINTS — one declaration per endpoint, carrying its own summary, input schema and
// handler. Mirrors `apps/moderator/src/lib/server/api-endpoint.ts`.
//
// There is ONE actor rule: the caller is a signed-in moderator. No service token opens these, because
// the privileged-permission gate, the per-actor rate limit and the audit row are all evaluated against
// the actor — a service identity would disable three controls at once and make the audit trail a
// record of which key was used rather than who acted.
//
//   a moderator's browser — the session cookie.
//   a spoke              — the same session, forwarded. A `*.civitai.com` spoke shares the hub's
//                          `.civitai.com` cookie, so relaying it server-side presents the credential
//                          the destination already accepts from that user's browser. It is one hop of
//                          one session, not a second scheme — and not cross-domain, which is why none
//                          of the `first-party-bridge` machinery (for spokes on another registrable
//                          domain, which cannot read that cookie) is involved.
//   a moderator's API key — `Authorization: Bearer` with a full-access personal key, for scripts and
//                          for Retool until it is retired. Any other token is refused.
//
// 🔒 These are mutating POSTs authenticated by a cookie, so CSRF is only prevented by the session
// cookie being `SameSite=Lax` (`server/auth/civ-cookie.ts`): a browser will not attach it to a
// cross-site POST. Relaxing that to `SameSite=None` would make every endpoint here forgeable from any
// page a moderator visits. If that attribute ever has to change, these endpoints need their own
// origin check first.

type AxiomAPIRequest = NextApiRequest & { log: Logger };

export type ModeratorCtx = {
  actor: SessionUser;
  tracker: Tracker;
  req: NextApiRequest;
  res: NextApiResponse;
  /** The personal API key that authenticated the call; null for a session. */
  apiKeyId: number | null;
};

export type ModeratorMethod = 'GET' | 'POST';

export type ModeratorSpec = {
  method: ModeratorMethod;
  /** `summary`, `returns`, `notes` and the input's `.describe()` texts document the route for its
   *  readers; no code reads them. */
  summary: string;
  /** Permission key required on top of the moderator role, from the `granted` feature-flag system. */
  privileged?: string;
  input?: z.ZodType;
  returns?: string;
  notes?: string[];
  rateLimit: { max: number; windowSeconds: number };
};

export type ModeratorDefinition<S extends z.ZodType, TOutput> = {
  /** Defaults to POST. GET is for reads only: a browser WILL send the session cookie on a
   *  top-level cross-site GET, so a mutating one would be forgeable where a POST is not. */
  method?: ModeratorMethod;
  summary: string;
  privileged?: string;
  input?: S;
  returns?: string;
  notes?: string[];
  rateLimit?: { max: number; windowSeconds: number };
  /**
   * Parameter names to keep OUT of the audit row. For a value the endpoint reads and then has no
   * further use for — a confirmation the caller had to type, rather than an input that changes what
   * the action does. The check still runs; only the recorded copy is dropped.
   */
  auditExclude?: (KeysOfUnion<z.input<S>> & string)[];
  /**
   * Return `{ affected: {...} }` alongside the response to populate the audit row's `affected` column;
   * the rest is sent as JSON.
   */
  handler: (input: z.output<S>, ctx: ModeratorCtx) => Promise<TOutput>;
};

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

const DEFAULT_RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

/**
 * `z.coerce.boolean()` runs the value through JS `Boolean()`, so the string `"false"` becomes `true` —
 * a privilege-escalation footgun on a flag like `isModerator`. Only explicit tokens are accepted.
 */
export const moderatorBoolean = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return v;
}, z.boolean());

type ActorResult =
  | { actor: SessionUser; fullCredential: boolean; apiKeyId: number | null }
  | { status: number; error: string };

async function resolveActor(req: NextApiRequest, res: NextApiResponse): Promise<ActorResult> {
  const authHeader = req.headers.authorization;

  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const session = await getSessionFromBearerToken(authHeader.slice('bearer '.length).trim());
    if (!session?.user) return { status: 401, error: 'Invalid API key' };
    return {
      actor: session.user as SessionUser,
      fullCredential: isFullScopeUserKey(session as BearerCredential),
      apiKeyId: (session as { apiKeyId?: number }).apiKeyId ?? null,
    };
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user) return { status: 401, error: 'Not signed in' };
  return {
    actor: session.user as SessionUser,
    fullCredential: isFullScopeSession(req),
    apiKeyId: null,
  };
}

/**
 * The actor rule every moderator endpoint applies: a signed-in, unbanned moderator (not a
 * moderation account) on a full-scope credential. Exported for a moderator route that cannot use
 * `defineModeratorEndpoint` because it does not answer JSON (the review agent chat streams).
 */
export async function authorizeModerator(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<{ actor: SessionUser; apiKeyId: number | null } | { status: number; error: string }> {
  const resolved = await resolveActor(req, res);
  if ('error' in resolved) return resolved;
  const { actor, fullCredential, apiKeyId } = resolved;
  if (
    !actor.isModerator ||
    actor.bannedAt ||
    refuseModerationAccountSession(actor, 'moderator-endpoint')
  ) {
    return { status: 403, error: 'Moderator role required' };
  }
  if (!fullCredential) return { status: 403, error: FULL_SCOPE_SESSION_REQUIRED };
  return { actor, apiKeyId };
}

/**
 * The per-actor rate limit every moderator endpoint applies. Per actor, not per endpoint: one
 * moderator running a script must not lock out the rest. `SET NX EX` + `INCR` in one MULTI so the
 * key always gets its TTL — a crash between the two would otherwise strand a TTL-less counter and
 * lock the actor out permanently. Answers 429 itself and returns false when the actor is over it.
 */
async function withinActorRateLimit(
  name: string,
  actorId: number,
  limit: { max: number; windowSeconds: number },
  res: NextApiResponse
): Promise<boolean> {
  // Key namespace still says RETOOL: it is a stored key, and renaming it would reset every live
  // counter mid-window. Rename with the ClickHouse event, or not at all.
  const rateKey = `${REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT}:${name}:${actorId}` as const;
  const multiResult = await sysRedis
    .multi()
    .set(rateKey, '0', { NX: true, EX: limit.windowSeconds })
    .incr(rateKey)
    .exec();
  if (Number(multiResult[1]) <= limit.max) return true;
  const retryAfter = await sysRedis.ttl(rateKey);
  res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
  res.status(429).json({
    error: 'Rate limit exceeded',
    retryAfterSeconds: retryAfter,
    limit: limit.max,
    windowSeconds: limit.windowSeconds,
  });
  return false;
}

export type ModeratorStreamCtx = {
  actor: SessionUser;
  apiKeyId: number | null;
  req: NextApiRequest;
  res: NextApiResponse;
};

export type ModeratorStreamDefinition = {
  rateLimit?: { max: number; windowSeconds: number };
  /**
   * Writes the response itself. Return `{ affected: {...} }` to write an audit row for the call
   * (`affected` is its `affected` column); return nothing for a call that did no work, such as a
   * refusal. A throw is audited as an error.
   */
  handler: (ctx: ModeratorStreamCtx) => Promise<unknown>;
};

/**
 * A moderator POST route that writes its own response (a stream) instead of returning JSON. The
 * same actor rule and per-actor rate limit as {@link defineModeratorEndpoint}, refused with the
 * same statuses and body shape; the handler owns everything after them, input validation and the
 * response included. The audit row records no request parameters (a stream route's body is the
 * caller's content), only what the handler returns as `affected`.
 *
 * @param name  stable id for the audit row and rate-limit key, as for `defineModeratorEndpoint`.
 */
export function defineModeratorStreamEndpoint(name: string, def: ModeratorStreamDefinition) {
  const limit = def.rateLimit ?? DEFAULT_RATE_LIMIT;
  return async function moderatorStreamEndpoint(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const authorized = await authorizeModerator(req, res);
    if ('error' in authorized)
      return res.status(authorized.status).json({ error: authorized.error });
    if (!(await withinActorRateLimit(name, authorized.actor.id, limit, res))) return;

    const tracker = new Tracker(req, res);
    let result: unknown;
    try {
      result = await def.handler({ ...authorized, req, res });
    } catch (e) {
      void tracker.retoolAudit({
        action: name,
        privileged: false,
        outcome: 'error',
        errorMsg: (e as Error).message ?? String(e),
        payload: {},
      });
      throw e;
    }
    const { affected } = extractAffected(result);
    if (affected)
      void tracker.retoolAudit({
        action: name,
        privileged: false,
        outcome: 'ok',
        payload: {},
        affected,
      });
  };
}

function collectInput(req: NextApiRequest): Record<string, unknown> {
  const query = req.query;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Query wins over body: the URL names the resource, so a body field disagreeing with it is a caller
  // mistake rather than an override. Both arrive as strings, so schemas need `z.coerce`.
  return { ...body, ...query };
}

const REQUEST_LEVEL_FIELDS = new Set(['token', 'authorization']);

/**
 * The audit row records an endpoint's own parameters.
 *
 * For an endpoint with a schema, the validated input's KEYS are an allowlist over the request as
 * sent, so a field the endpoint does not declare is not recorded as something it was called with,
 * and a field added to the request surface later needs no maintenance here. An endpoint with no
 * usable schema has nothing to allowlist against and falls back to the request as sent, less the
 * request-level fields.
 */
function auditablePayload(
  raw: Record<string, unknown>,
  parsed: unknown,
  hasSchema: boolean,
  exclude: string[] = []
): Record<string, unknown> {
  const dropped = new Set(exclude.map((key) => key.toLowerCase()));
  // The KEYS come from the schema; the VALUES stay as the request sent them. Recording the coerced
  // value instead would make new rows disagree with stored ones wherever a value arrived as a
  // string — `42` where they hold `'42'` — for no gain here.
  // TWO conditions, because neither covers the other and dropping either one loses a case.
  //
  // An empty allowlist filters every request key out and writes `{}` for a privileged action, with
  // nothing to indicate it happened — that is what a top-level `z.coerce.date()`, a Map, a Set or a
  // `.transform()` returning an object with no own enumerable keys all produce.
  //
  // An ARRAY is the case emptiness does NOT catch: `Object.keys(['42'])` is `['0']`, non-empty and
  // matching no real parameter, so the payload comes out `{}` just the same.
  if (hasSchema && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const declared = new Set(Object.keys(parsed as Record<string, unknown>));
    if (declared.size > 0)
      return Object.fromEntries(
        Object.entries(raw).filter(([key]) => declared.has(key) && !dropped.has(key.toLowerCase()))
      );
  }
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => !REQUEST_LEVEL_FIELDS.has(key.toLowerCase()) && !dropped.has(key.toLowerCase())
    )
  );
}

function extractAffected(result: unknown): {
  affected?: Record<string, unknown>;
  response: Record<string, unknown>;
} {
  if (result && typeof result === 'object' && 'affected' in result) {
    const { affected, ...response } = result as Record<string, unknown>;
    return { affected: affected as Record<string, unknown>, response };
  }
  return { response: (result ?? {}) as Record<string, unknown> };
}

/**
 * @param name  stable id for the audit row and rate-limit key, e.g. `homeblock.create`. Renaming one
 *              splits its audit history, so treat it like a column name.
 */
export function defineModeratorEndpoint<S extends z.ZodType, TOutput>(
  name: string,
  def: ModeratorDefinition<S, TOutput>
) {
  const spec: ModeratorSpec = {
    method: def.method ?? 'POST',
    summary: def.summary,
    privileged: def.privileged,
    input: def.input,
    returns: def.returns,
    notes: def.notes,
    rateLimit: def.rateLimit ?? DEFAULT_RATE_LIMIT,
  };

  const handle = withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (req.method !== spec.method) {
      res.setHeader('Allow', spec.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const authorized = await authorizeModerator(req, res);
    if ('error' in authorized)
      return res.status(authorized.status).json({ error: authorized.error });

    const { actor, apiKeyId } = authorized;
    if (def.privileged && !actor.permissions?.includes(def.privileged)) {
      return res
        .status(403)
        .json({ error: `Permission "${def.privileged}" required for this action` });
    }

    const raw = collectInput(req);
    let input = raw as z.output<S>;
    if (def.input) {
      // Field-level issues are returned, not swallowed: for a script the difference between a fix and
      // a guess is knowing WHICH parameter was wrong.
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
      }
      input = parsed.data as z.output<S>;
    }

    if (!(await withinActorRateLimit(name, actor.id, spec.rateLimit, res))) return;

    const auditPayload = auditablePayload(raw, input, Boolean(def.input), def.auditExclude);
    const tracker = new Tracker(req, res);
    try {
      const result = await def.handler(input, { actor, tracker, req, res, apiKeyId });
      const { affected, response } = extractAffected(result);
      void tracker.retoolAudit({
        action: name,
        privileged: Boolean(def.privileged),
        outcome: 'ok',
        payload: auditPayload,
        affected,
      });
      return res.status(200).json(response);
    } catch (e) {
      const err = e as Error;
      void tracker.retoolAudit({
        action: name,
        privileged: Boolean(def.privileged),
        outcome: e instanceof CommittedRetryableError ? 'warning' : 'error',
        errorMsg: err.message ?? String(e),
        payload: auditPayload,
        affected: e instanceof CommittedRetryableError ? e.affected : undefined,
      });
      return handleEndpointError(res, e);
    }
  });

  return handle;
}

/**
 * Thrown by a handler whose write committed but whose follow-up step failed, so repeating the call is
 * safe. Answers 503, and is audited as a `warning` rather than an `error`: the action took.
 */
export class CommittedRetryableError extends TRPCError {
  constructor(message: string, readonly affected?: Record<string, unknown>) {
    super({ code: 'SERVICE_UNAVAILABLE', message });
  }
}
