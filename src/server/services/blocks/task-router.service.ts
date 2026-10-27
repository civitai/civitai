import { createHmac } from 'crypto';
import type { JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import * as z from 'zod';
import { env } from '~/env/server';
import type { TaskErrorCode } from '~/server/schema/blocks/workflow.schema';

const TICKET_ISSUER = 'task-router';
const TICKET_CLOCK_SKEW_SECONDS = 5;
const MATCH_TIMEOUT_MS = 15_000;
const STARTED_TIMEOUT_MS = 5_000;

// A ticket's tags land beside `app-block:<appId>`, the tag that scopes workflows to an app,
// so only the two shapes the router documents are accepted.
const ROUTER_TAG_REGEX = /^(?:task:[A-Za-z0-9.]+@[0-9]+|task:chain|tr:[A-Za-z0-9_]+)$/;
const TICKET_VERSION = 2;
const TICKET_MAX_STEPS = 8;

export type TaskRouterConfig = {
  url: string;
  partyKey: string;
  partyId: string;
  callbackOrigin: string;
  appAllowlist: string[];
};

/** `null` when the router is not configured, which keeps `kind:'task'` off. */
export function getTaskRouterConfig(): TaskRouterConfig | null {
  if (!env.TASK_ROUTER_URL || !env.TASK_ROUTER_PARTY_KEY || !env.TASK_ROUTER_CALLBACK_ORIGIN) {
    return null;
  }
  return {
    url: env.TASK_ROUTER_URL,
    partyKey: env.TASK_ROUTER_PARTY_KEY,
    partyId: env.TASK_ROUTER_PARTY_ID,
    callbackOrigin: new URL(env.TASK_ROUTER_CALLBACK_ORIGIN).origin,
    appAllowlist: env.TASK_ROUTER_APP_ALLOWLIST,
  };
}

/**
 * The opaque user ref sent to the router: keyed on the party key, so the router never sees
 * a Civitai user id and cannot enumerate one from a ref.
 */
export function taskRouterUserRef(partyKey: string, userId: number): string {
  return (
    'u_' + createHmac('sha256', partyKey).update(String(userId)).digest('base64url').slice(0, 22)
  );
}

export type TaskBudget = { amount: number; currency: string };

const moneySchema = z.object({ amount: z.number(), currency: z.string() });

const resolvedStepSchema = z.object({
  step: z.string(),
  goal: z.string(),
  tier: z.string(),
  ability: z.string(),
  provider: z.string(),
  via: z.string(),
  assignment: z.object({
    event: z.string(),
    reason: z.string().optional(),
    from: z.string().optional(),
  }),
});
export type TaskResolvedStep = z.infer<typeof resolvedStepSchema>;

const matchedSchema = z.object({
  status: z.literal('matched'),
  taskId: z.string(),
  resolvedAs: z.array(resolvedStepSchema).min(1),
  quote: moneySchema,
  ticket: z.string(),
  unknownFields: z.record(z.string(), z.array(z.string())).optional(),
});

const notYetSchema = z.object({
  status: z.literal('not_yet'),
  demandId: z.string(),
  closest: z.array(
    z.object({ goal: z.string(), description: z.string().optional(), score: z.number() })
  ),
});
export type TaskNotYet = z.infer<typeof notYetSchema>;

const matchReplySchema = z.discriminatedUnion('status', [matchedSchema, notYetSchema]);

const matchErrorSchema = z.object({ error: z.string(), message: z.string().optional() });

const ROUTER_ERROR_CODES = new Set<string>([
  'invalid_input',
  'tier_unavailable',
  'over_budget',
  'unsupported_currency',
  'pin_unavailable',
  'no_provider',
] satisfies TaskErrorCode[]);

type TaskPin = { ability: string } | { provider: string };
type TaskQuality = 'draft' | 'standard' | 'best';

export type TaskMatchRequest = {
  task?: string;
  input?: Record<string, unknown>;
  steps?: {
    name?: string;
    task?: string;
    input?: Record<string, unknown>;
    quality?: TaskQuality;
    description?: string;
    pin?: TaskPin;
  }[];
  quality?: TaskQuality;
  description?: string;
  routing?: 'sticky' | 'each-request';
  pin?: TaskPin;
  budget: TaskBudget;
  requester: { app: string; user: string };
};

export type TaskMatchResult =
  | { ok: true; match: z.infer<typeof matchedSchema> }
  | { ok: true; notYet: TaskNotYet }
  | { ok: false; code: TaskErrorCode; message: string };

export async function matchTask(
  config: TaskRouterConfig,
  request: TaskMatchRequest,
  fetchImpl: typeof fetch = fetch
): Promise<TaskMatchResult> {
  let res: Response;
  try {
    res = await fetchImpl(new URL('/v1/tasks/match', config.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.partyKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(MATCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'task-unavailable', message: 'task router unreachable' };
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const parsed = matchReplySchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, code: 'task-unavailable', message: 'task router sent a malformed match' };
    }
    return parsed.data.status === 'matched'
      ? { ok: true, match: parsed.data }
      : { ok: true, notYet: parsed.data };
  }
  const err = matchErrorSchema.safeParse(json);
  if (err.success && ROUTER_ERROR_CODES.has(err.data.error)) {
    return {
      ok: false,
      code: err.data.error as TaskErrorCode,
      message: err.data.message ?? err.data.error,
    };
  }
  return { ok: false, code: 'task-unavailable', message: `task router answered ${res.status}` };
}

/** Best effort: outcomes are callback-first, so a lost `/started` only delays traceability. */
export async function reportTaskStarted(
  config: TaskRouterConfig,
  taskId: string,
  providerJobId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await fetchImpl(new URL(`/v1/tasks/${encodeURIComponent(taskId)}/started`, config.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.partyKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ providerJobId }),
    signal: AbortSignal.timeout(STARTED_TIMEOUT_MS),
  }).catch(() => undefined);
}

let remoteJwks: { url: string; getKey: JWTVerifyGetKey } | undefined;

export function taskRouterJwks(config: TaskRouterConfig): JWTVerifyGetKey {
  const url = new URL('/.well-known/jwks.json', config.url).toString();
  if (remoteJwks?.url !== url) remoteJwks = { url, getKey: createRemoteJWKSet(new URL(url)) };
  return remoteJwks.getKey;
}

const ticketClaimsSchema = z.object({
  v: z.number(),
  sub: z.string(),
  jti: z.string(),
  provider: z.string(),
  steps: z.array(
    z.object({ name: z.string(), goal: z.string(), ability: z.string(), via: z.string() })
  ),
  budget: moneySchema,
  quote: moneySchema,
  user: z.string().optional(),
  request: z.object({
    kind: z.literal('orchestrator.workflow'),
    workflow: z.object({
      steps: z.array(
        z.object({
          $type: z.string(),
          name: z.string().optional(),
          input: z.record(z.string(), z.unknown()),
        })
      ),
      tags: z.array(z.string()),
      metadata: z.object({ taskRouter: z.record(z.string(), z.unknown()) }),
      callbacks: z
        .array(
          z.object({
            url: z.string(),
            type: z.array(z.string()),
            detailed: z.boolean().optional(),
          })
        )
        .optional(),
    }),
  }),
});

export type TaskTicketStep = { $type: string; name?: string; input: Record<string, unknown> };

export type VerifiedTaskTicket = {
  taskId: string;
  quote: TaskBudget;
  /** 1 to 8, in workflow order; later steps may `$ref` earlier ones by name. */
  steps: TaskTicketStep[];
  tags: string[];
  metadata: { taskRouter: Record<string, unknown> };
  callbacks: { url: string; type: string[]; detailed?: boolean }[];
};

export class TaskTicketError extends Error {}

/** Throws `TaskTicketError` naming the first check that failed. The `$type` denylist is the pass-through submit's. */
export async function verifyTaskTicket(
  jws: string,
  opts: {
    jwks: JWTVerifyGetKey;
    audience: string;
    budget: TaskBudget;
    user?: string;
    callbackOrigin: string;
    currentDate?: Date;
  }
): Promise<VerifiedTaskTicket> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(jws, opts.jwks, {
      algorithms: ['EdDSA'],
      issuer: TICKET_ISSUER,
      audience: opts.audience,
      clockTolerance: TICKET_CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp', 'jti', 'sub'],
      currentDate: opts.currentDate,
    }));
  } catch (e) {
    const reason = e instanceof joseErrors.JOSEError ? e.code : 'unverifiable';
    throw new TaskTicketError(`ticket rejected: ${reason}`);
  }

  const parsed = ticketClaimsSchema.safeParse(payload);
  if (!parsed.success) throw new TaskTicketError('ticket rejected: unexpected claims');
  const claims = parsed.data;

  if (claims.v !== TICKET_VERSION)
    throw new TaskTicketError('ticket rejected: unsupported version');
  if (claims.jti !== claims.sub) throw new TaskTicketError('ticket rejected: jti/sub mismatch');
  if (
    claims.budget.amount !== opts.budget.amount ||
    claims.budget.currency !== opts.budget.currency
  ) {
    throw new TaskTicketError('ticket rejected: budget differs from the one sent');
  }
  if (claims.quote.currency !== opts.budget.currency || claims.quote.amount > opts.budget.amount) {
    throw new TaskTicketError('ticket rejected: quote exceeds the budget');
  }
  if (opts.user !== undefined && claims.user !== opts.user) {
    throw new TaskTicketError('ticket rejected: user differs from the one sent');
  }
  const { workflow } = claims.request;
  if (workflow.steps.length < 1 || workflow.steps.length > TICKET_MAX_STEPS) {
    throw new TaskTicketError(`ticket rejected: expected 1 to ${TICKET_MAX_STEPS} steps`);
  }
  if (!workflow.tags.every((tag) => ROUTER_TAG_REGEX.test(tag))) {
    throw new TaskTicketError('ticket rejected: unexpected workflow tag');
  }
  const callbacks = workflow.callbacks ?? [];
  for (const callback of callbacks) {
    if (!sameOrigin(callback.url, opts.callbackOrigin)) {
      throw new TaskTicketError('ticket rejected: callback outside the router origin');
    }
  }

  return {
    taskId: claims.jti,
    quote: claims.quote,
    steps: workflow.steps,
    tags: workflow.tags,
    metadata: { taskRouter: workflow.metadata.taskRouter },
    callbacks,
  };
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
