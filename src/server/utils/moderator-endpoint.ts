import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from '~/server/clickhouse/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

// MODERATOR ENDPOINTS — one declaration per endpoint, carrying its own summary, input schema and
// handler. Mirrors `apps/moderator/src/lib/server/api-endpoint.ts`, for the same reason: the spec is
// built FROM the schema that validates the request, so a parameter cannot be documented and not
// enforced, or enforced and not documented. `/moderator/api` renders these specs, and a docs page that
// drifts from its API is worse than no docs page — it is a list of calls that used to work.
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
//   a moderator's API key — `Authorization: Bearer`, for scripts and for Retool until it is retired.
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
};

export type ModeratorMethod = 'GET' | 'POST';

export type ModeratorSpec = {
  method: ModeratorMethod;
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
   * Return `{ affected: {...} }` alongside the response to populate the audit row's `affected` column;
   * the rest is sent as JSON.
   */
  handler: (input: z.output<S>, ctx: ModeratorCtx) => Promise<TOutput>;
};

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

type ActorResult = { actor: SessionUser } | { status: number; error: string };

async function resolveActor(req: NextApiRequest, res: NextApiResponse): Promise<ActorResult> {
  const authHeader = req.headers.authorization;

  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const session = await getSessionFromBearerToken(authHeader.slice('bearer '.length).trim());
    if (!session?.user) return { status: 401, error: 'Invalid API key' };
    return { actor: session.user as SessionUser };
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user) return { status: 401, error: 'Not signed in' };
  return { actor: session.user as SessionUser };
}

function collectInput(req: NextApiRequest): Record<string, unknown> {
  const query = req.query;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Query wins over body: the URL names the resource, so a body field disagreeing with it is a caller
  // mistake rather than an override. Both arrive as strings, so schemas need `z.coerce`.
  return { ...body, ...query };
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

    const resolved = await resolveActor(req, res);
    if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });

    const { actor } = resolved;
    if (!actor.isModerator || actor.bannedAt) {
      return res.status(403).json({ error: 'Moderator role required' });
    }
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

    // Per actor, not per endpoint: one moderator running a script must not lock out the rest.
    // `SET NX EX` + `INCR` in one MULTI so the key always gets its TTL — a crash between the two would
    // otherwise strand a TTL-less counter and lock the actor out permanently.
    const limit = spec.rateLimit;
    // Key namespace still says RETOOL: it is a stored key, and renaming it would reset every live
    // counter mid-window. Rename with the ClickHouse event, or not at all.
    const rateKey = `${REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT}:${name}:${actor.id}` as const;
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: limit.windowSeconds })
      .incr(rateKey)
      .exec();
    if (Number(multiResult[1]) > limit.max) {
      const retryAfter = await sysRedis.ttl(rateKey);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterSeconds: retryAfter,
        limit: limit.max,
        windowSeconds: limit.windowSeconds,
      });
    }

    const tracker = new Tracker(req, res);
    try {
      const result = await def.handler(input, { actor, tracker, req, res });
      const { affected, response } = extractAffected(result);
      void tracker.retoolAudit({
        action: name,
        privileged: Boolean(def.privileged),
        outcome: 'ok',
        payload: raw,
        affected,
      });
      return res.status(200).json(response);
    } catch (e) {
      const err = e as Error;
      void tracker.retoolAudit({
        action: name,
        privileged: Boolean(def.privileged),
        outcome: 'error',
        errorMsg: err.message ?? String(e),
        payload: raw,
      });
      return handleEndpointError(res, e);
    }
  });

  // The catalog reads `spec` off the exported handler — same trick the spoke uses, so neither side has
  // a documentation list that can disagree with the code.
  return Object.assign(handle, { spec, endpointName: name });
}

export type ModeratorEndpointDoc = {
  method: ModeratorMethod;
  summary: string;
  privileged?: string;
  returns?: string;
  notes?: string[];
  rateLimit: { max: number; windowSeconds: number };
  params: { name: string; type: string; required: boolean; description?: string }[];
};

/** A zod schema projected to JSON Schema. OpenAPI 3.1 uses JSON Schema for its own schema objects,
 *  so this drops into an OpenAPI document unchanged — which is why the document can be built from
 *  the same specs the reference page renders. */
export type ProjectedSchema = {
  properties?: Record<string, { type?: string; description?: string } & Record<string, unknown>>;
  required?: string[];
};

/**
 * Zod's JSON-Schema projection cannot express every type it can validate, and its default is to THROW:
 * a single `z.coerce.date()` param took the whole reference page down, because the catalog builds all
 * 26 docs in one pass. Two guards, because they cover different things.
 *
 * `unrepresentable: 'any'` handles the known case — a Date projects as an untyped param rather than an
 * exception. The catch handles the ones nobody has hit yet: a schema this cannot project should cost
 * that endpoint its parameter table, not cost every other endpoint its entry.
 */
export function projectSchema(input: z.ZodType): ProjectedSchema {
  try {
    return z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as ProjectedSchema;
  } catch (e) {
    console.error('[moderator-endpoint] could not project a schema for the docs page', e);
    return {};
  }
}

/**
 * Params come from the schema via zod's JSON-Schema projection, so the documented contract is the
 * enforced one.
 *
 * Optional fields are OMITTED rather than set to `undefined`. This is consumed by
 * `getServerSideProps`, and Next refuses to serialise `undefined` — an endpoint with no `privileged`
 * key took the whole page down with a 500 rather than rendering without that badge.
 */
export function specToDoc(spec: ModeratorSpec): ModeratorEndpointDoc {
  const base = {
    method: spec.method,
    summary: spec.summary,
    rateLimit: spec.rateLimit,
    ...(spec.privileged ? { privileged: spec.privileged } : {}),
    ...(spec.returns ? { returns: spec.returns } : {}),
    ...(spec.notes?.length ? { notes: spec.notes } : {}),
  };
  if (!spec.input) return { ...base, params: [] };

  const schema = projectSchema(spec.input);
  const required = new Set(schema.required ?? []);

  return {
    ...base,
    params: Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
      name,
      type: prop.type ?? 'unknown',
      required: required.has(name),
      ...(prop.description ? { description: prop.description } : {}),
    })),
  };
}
