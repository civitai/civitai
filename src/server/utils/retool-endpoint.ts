import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

export type RetoolCtx = {
  actor: SessionUser;
  tracker: Tracker;
  req: NextApiRequest;
  res: NextApiResponse;
};

export interface RetoolAction<TInput extends z.ZodObject<z.ZodRawShape>, TOutput> {
  input: TInput;
  /**
   * Permission key required to invoke the action. Maps to a `granted`-availability
   * feature flag in `feature-flags.service.ts`. The calling moderator must have
   * the matching entry in `user.permissions`. Absent = no extra gate beyond the
   * baseline `isModerator` check.
   */
  privileged?: string;
  rateLimit?: { max: number; windowSeconds: number };
  // Method syntax (intentional) — bivariant params let us store concrete
  // action types in a `Record<string, RetoolAction<ZodObject<any>, any>>`
  // registry without TypeScript fighting us on contravariance.
  handler(input: z.infer<TInput>, ctx: RetoolCtx): Promise<TOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RetoolActionAny = RetoolAction<z.ZodObject<any>, any>;

type RetoolRegistry = Record<string, RetoolActionAny>;

/**
 * Identity helper that captures per-action input/output generics. Use this at call
 * sites so the handler's `input` parameter is typed from the zod schema:
 *
 *   bump: retoolAction({
 *     input: z.object({ modelId: z.number() }),
 *     handler: async (input) => { ... } // input: { modelId: number }
 *   })
 */
export function retoolAction<TInput extends z.ZodObject<z.ZodRawShape>, TOutput>(
  config: RetoolAction<TInput, TOutput>
): RetoolAction<TInput, TOutput> {
  return config;
}

/**
 * Safe boolean parser for Retool inputs. `z.coerce.boolean()` passes the value
 * through JS `Boolean()`, so the string `"false"` evaluates to `true` — which
 * would be a privilege-escalation footgun on flags like `isModerator` or
 * `permanentUnlock`. This preprocessor only accepts explicit truthy/falsy
 * tokens.
 */
export const retoolBoolean = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return v; // let z.boolean() reject anything else
}, z.boolean());

const DEFAULT_RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

/**
 * Registry-based wrapper for Retool-callable mod endpoints. Each action declares its
 * own input schema, rate limit, privileged flag, and handler in one record. The
 * wrapper builds a discriminated union schema from the registry, applies auth + rate
 * limit + audit logging, and dispatches to the matching handler.
 *
 * Auth: `Authorization: Bearer <user API key>` resolves to a Civitai user. The user
 * must be a moderator. Privileged actions additionally require the matching
 * permission key in `user.permissions` (granted via the standard `granted`
 * feature-flag system).
 *
 * Audit: every call (success and error) emits a `retoolAuditLog` event to ClickHouse
 * via the Tracker client.
 *
 * Handlers may return `{ affected: { ... } }` to populate the `affected` column on
 * the audit row; the rest of the return value is sent back as the JSON response.
 */
export function defineRetoolEndpoint<TRegistry extends RetoolRegistry>(
  domain: string,
  actions: TRegistry
) {
  const actionEntries = Object.entries(actions);
  if (actionEntries.length === 0) {
    throw new Error(`defineRetoolEndpoint(${domain}) requires at least one action`);
  }

  const variants = actionEntries.map(([name, action]) =>
    action.input.extend({ action: z.literal(name) })
  );

  const schema =
    variants.length === 1
      ? variants[0]
      : (z.discriminatedUnion(
          'action',
          variants as unknown as [
            z.ZodObject<{ action: z.ZodLiteral<string> } & z.ZodRawShape>,
            z.ZodObject<{ action: z.ZodLiteral<string> } & z.ZodRawShape>,
            ...z.ZodObject<{ action: z.ZodLiteral<string> } & z.ZodRawShape>[]
          ]
        ) as unknown as z.ZodObject<z.ZodRawShape>);

  return withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // 1. Auth — Bearer token resolves to a user
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Bearer token' });
    }
    const apiKey = authHeader.slice('bearer '.length).trim();
    const session = await getSessionFromBearerToken(apiKey);
    if (!session?.user) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const actor = session.user as SessionUser;
    if (!actor.isModerator || actor.bannedAt) {
      return res.status(403).json({ error: 'Moderator role required' });
    }

    // 2. Schema parse
    const parsed = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid request', issues: parsed.error.issues });
    }
    const input = parsed.data as z.infer<typeof schema> & { action: keyof TRegistry };
    const action = actions[input.action as string];
    const actionKey = `${domain}.${String(input.action)}`;

    // 3. Privileged gate — granted permission required.
    if (action.privileged && !actor.permissions?.includes(action.privileged)) {
      return res
        .status(403)
        .json({ error: `Permission "${action.privileged}" required for this action` });
    }

    // 4. Rate limit (per action, per actor) — `SET NX EX` + `INCR` in one
    // round-trip via MULTI. Atomic: the key is always created with its TTL,
    // so a crash between INCR and EXPIRE can't strand a TTL-less counter
    // that would permanently lock the actor out.
    const limit = action.rateLimit ?? DEFAULT_RATE_LIMIT;
    const rateKey =
      `${REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT}:${actionKey}:${actor.id}` as const;
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: limit.windowSeconds })
      .incr(rateKey)
      .exec();
    const count = Number(multiResult[1]);
    if (count > limit.max) {
      const retryAfter = await sysRedis.ttl(rateKey);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterSeconds: retryAfter,
        limit: limit.max,
        windowSeconds: limit.windowSeconds,
      });
    }

    // 5. Dispatch + audit
    const tracker = new Tracker(req, res);
    const payload = sanitizePayload(input);

    try {
      const result = await action.handler(parsed.data as never, {
        actor,
        tracker,
        req,
        res,
      });
      const { affected, ...response } = extractAffected(result);
      void tracker.retoolAudit({
        action: actionKey,
        privileged: Boolean(action.privileged),
        outcome: 'ok',
        payload,
        affected,
      });
      return res.status(200).json(response);
    } catch (e) {
      const err = e as Error;
      void tracker.retoolAudit({
        action: actionKey,
        privileged: Boolean(action.privileged),
        outcome: 'error',
        errorMsg: err.message ?? String(e),
        payload,
      });
      return handleEndpointError(res, e);
    }
  });
}

function sanitizePayload(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = input;
  return rest;
}

function extractAffected(result: unknown): {
  affected: Record<string, unknown> | undefined;
  [key: string]: unknown;
} {
  if (!result || typeof result !== 'object') {
    return { affected: undefined, value: result };
  }
  if ('affected' in result) {
    const { affected, ...rest } = result as { affected: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    return { affected, ...rest };
  }
  return { affected: undefined, ...(result as Record<string, unknown>) };
}
