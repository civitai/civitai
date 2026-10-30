import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  encodeRunEvent,
  RUN_KEEPALIVE_MS,
  type RunErrorCode,
  type RunErrorResponse,
  type RunJson,
} from '@civitai/components-chat/runner-protocol';
import { z } from 'zod';

import type { Authenticator, GrantVerifier, RunGrant } from './interfaces';
import { GRANT_HEADER, grantHeader, RUNNER_FEATURES } from './protocol';
import type { RunService } from './service';
import { refuseAll, refuseGrants } from './unconfigured';

/** What a deployment's own routes (`RunAppOptions.routes`) are handed to serve as the run API does. */
export interface RunRoutes {
  /** A pre-handler that answers 401/403 unless the request signs in; sets `request.userId`. */
  authed(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
  /**
   * The run grant the request carries, verified and bound to this viewer and conversation (and,
   * when given, the idempotency key); `preview` asks for a preview grant instead of a run grant.
   */
  grantFor(
    request: FastifyRequest,
    conversationId: string,
    idempotencyKey?: string,
    preview?: boolean
  ): Promise<RunGrant | null>;
  /** Answers with the protocol's error body and the status its code maps to. */
  refuse(reply: FastifyReply, error: RunErrorCode, message: string, runId?: string): FastifyReply;
}

export interface RunAppOptions {
  service: RunService;
  /** Who a request acts for. Without one every run-API request is refused. */
  authenticator?: Authenticator;
  /** Checks the run grant a start (or a patch) carries. Without one every start is refused. */
  grants?: GrantVerifier;
  /** The deployment's own routes, served under the base path beside the run API. */
  routes?(api: FastifyInstance, helpers: RunRoutes): void;
  /**
   * Why a patch that threw is the client's to fix rather than the runner's failure: the words it is
   * refused with (403), or `undefined` for an error the runner answers 503.
   */
  patchRefusal?(error: unknown): string | undefined;
  /**
   * Whether a start (or a patch) may name this model. A start naming any other is refused (400) before
   * it reaches the service, and so is a patch setting it. Without one any model is taken.
   */
  acceptsModel?(model: string): boolean;
  /** The path the run API is served under (`RUNNER_BASE_PATH`); `''` for the root. */
  basePath?: string;
  logger?: FastifyServerOptions['logger'];
  /** How often an open event stream gets a comment, so the client can tell a quiet run from a dead connection. */
  keepaliveMs?: number;
}

/** What a start or patch naming a model the runner does not offer (`acceptsModel`) is refused with. */
export const MODEL_REFUSAL =
  'This runner does not offer that model. Pick one of the listed models.';

const STATUS: Record<RunErrorCode, number> = {
  'run-active': 409,
  'stale-turn': 409,
  refused: 403,
  unauthorized: 401,
  'bad-request': 400,
  'not-found': 404,
  unavailable: 503,
};

const json: z.ZodType<RunJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ])
);
const id = z.string().min(1).max(200);

const attachment = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video', 'audio']),
  source: z.union([
    z.object({ type: z.literal('upload'), blobId: z.string() }),
    z.object({
      type: z.literal('result'),
      workflowId: z.string(),
      job: z.string(),
      path: z.string(),
    }),
  ]),
  url: z.string().optional(),
  mime: z.string().optional(),
  name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  caption: z.string().optional(),
  nsfwLevel: z.string().optional(),
  blocked: z.boolean().optional(),
});

const startBody = z.object({
  v: z.literal(1),
  idempotencyKey: id,
  conversationId: id,
  scope: z.string().max(200).optional(),
  turn: z.object({
    seq: z.number().int().positive(),
    user: z.object({
      content: z.string(),
      attachments: z.array(attachment),
      refs: z.array(z.string()).optional(),
    }),
    retry: z.boolean().optional(),
    edit: z.boolean().optional(),
  }),
  model: z.string().min(1).max(200),
  settings: z.object({
    customInstructions: z.string().optional(),
    hostInstructions: z.string().optional(),
    maxOutputTokens: z.number().int().positive(),
    tier: z.enum(['auto', 'free', 'paid']),
    allowMature: z.boolean(),
    autoRunLimit: z.number().nonnegative(),
    spokenReplies: z.boolean(),
  }),
  page: z.record(z.string(), json).optional(),
});

const stopBody = z.object({ v: z.literal(1) });
const stopByKeyBody = z.object({ v: z.literal(1), idempotencyKey: id, conversationId: id });
const patchBody = z.object({
  v: z.literal(1),
  title: z.string().max(200).optional(),
  titleSource: z.enum(['llm', 'user']).optional(),
  model: z.string().max(200).nullable().optional(),
});

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

function refuse(
  reply: FastifyReply,
  error: RunErrorCode,
  message: string,
  runId?: string
): FastifyReply {
  const body: RunErrorResponse = { v: 1, error, message, ...(runId ? { runId } : {}) };
  return reply.code(STATUS[error]).send(body);
}

/** `Last-Event-ID` as a journal position, or `undefined` (send the whole journal) when absent or not one. */
export function lastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

export function buildRunApp(options: RunAppOptions): FastifyInstance {
  const { service } = options;
  const authenticator = options.authenticator ?? refuseAll;
  const grants = options.grants ?? refuseGrants;
  const keepaliveMs = options.keepaliveMs ?? Math.floor((RUN_KEEPALIVE_MS * 2) / 3);
  const acceptsModel = options.acceptsModel ?? (() => true);
  const app = Fastify({ logger: options.logger ?? false });
  const streams = new Set<AbortController>();

  app.addHook('onClose', async () => {
    for (const stream of streams) stream.abort();
  });

  app.setErrorHandler((error, request, reply) => {
    // Fastify's own refusals (a body that is not JSON, or too large): asking again would not help.
    // Anything else, whatever status it carries, is the runner's failure. Not every error's code is a
    // string: a DOMException's is a number (a TimeoutError's is 23).
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('FST_'))
      return refuse(reply, 'bad-request', 'The request is not one this runner reads.');
    request.log.error({ err: error }, 'request failed');
    const body: RunErrorResponse = {
      v: 1,
      error: 'unavailable',
      message: 'The runner could not do that just now.',
    };
    return reply.code(503).send(body);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) =>
    service.ready() ? { ok: true } : reply.code(503).send({ ok: false })
  );

  const authed = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await authenticator.authenticate(request.headers);
    if (!result.ok)
      return refuse(reply, result.status === 403 ? 'refused' : 'unauthorized', result.message);
    // An empty id would put every such viewer in one namespace, able to see and stop each other's runs.
    if (typeof result.userId !== 'string' || !result.userId)
      return refuse(reply, 'unauthorized', 'Sign in.');
    request.userId = result.userId;
  };

  /**
   * The run grant the request carries, verified and bound to this viewer and conversation (and, for
   * a start, its idempotency key); `null` when there is none or it is not one of those. A preview
   * grant is good only where `preview` is asked for, and only a preview grant is good there.
   */
  const grantFor = async (
    request: FastifyRequest,
    conversationId: string,
    idempotencyKey?: string,
    preview = false
  ): Promise<RunGrant | null> => {
    const token = grantHeader(request.headers);
    const grant = token ? await grants.grant(token) : null;
    if (
      !grant ||
      (grant.preview === true) !== preview ||
      grant.userId !== request.userId ||
      grant.conversationId !== conversationId ||
      (idempotencyKey !== undefined && grant.idempotencyKey !== idempotencyKey)
    )
      return null;
    return grant;
  };

  /** The run API, served under the base path. */
  const routes = (app: FastifyInstance) => {
    app.post('/runs', { preHandler: authed }, async (request, reply) => {
      const body = startBody.safeParse(request.body);
      if (!body.success)
        return refuse(reply, 'bad-request', 'The start request is not one this runner reads.');
      const grant = await grantFor(request, body.data.conversationId, body.data.idempotencyKey);
      if (!grant)
        return refuse(
          reply,
          'refused',
          `This start needs a current run grant for this chat in ${GRANT_HEADER}.`
        );
      const outcome = await service.start(request.userId, body.data, grant);
      if (!outcome.ok) return refuse(reply, outcome.error, outcome.message, outcome.runId);
      return reply.code(201).send({ ...outcome.response, features: [...RUNNER_FEATURES] });
    });

    app.get('/runs', { preHandler: authed }, async (request, reply) => {
      const conversationId = (request.query as Record<string, unknown>).conversationId;
      if (typeof conversationId !== 'string' || !conversationId)
        return refuse(reply, 'bad-request', 'conversationId is required.');
      return {
        v: 1,
        run: await service.lookup(request.userId, conversationId),
        features: [...RUNNER_FEATURES],
      };
    });

    app.post('/runs/stop', { preHandler: authed }, async (request, reply) => {
      const body = stopByKeyBody.safeParse(request.body);
      if (!body.success)
        return refuse(reply, 'bad-request', 'The stop request is not one this runner reads.');
      await service.stopByKey(request.userId, body.data.idempotencyKey);
      return reply.code(202).send();
    });

    app.post<{ Params: { runId: string } }>(
      '/runs/:runId/stop',
      { preHandler: authed },
      async (request, reply) => {
        if (!stopBody.safeParse(request.body ?? { v: 1 }).success)
          return refuse(reply, 'bad-request', 'The stop request is not one this runner reads.');
        if (!(await service.stop(request.userId, request.params.runId)))
          return refuse(reply, 'not-found', 'No such run.');
        return reply.code(202).send();
      }
    );

    app.post<{ Params: { id: string } }>(
      '/conversations/:id/patch',
      { preHandler: authed },
      async (request, reply) => {
        const body = patchBody.safeParse(request.body);
        if (!body.success)
          return refuse(reply, 'bad-request', 'The patch is not one this runner reads.');
        // `null` (follow the default) is always taken.
        if (typeof body.data.model === 'string' && !acceptsModel(body.data.model))
          return refuse(reply, 'bad-request', MODEL_REFUSAL);
        // Optional here: without one the store acts with a live run's grant for this chat.
        let grant: RunGrant | undefined;
        if (grantHeader(request.headers)) {
          grant = (await grantFor(request, request.params.id)) ?? undefined;
          if (!grant)
            return refuse(
              reply,
              'refused',
              `The run grant in ${GRANT_HEADER} is not for this chat.`
            );
        }
        let found: boolean;
        try {
          found = await service.patch(request.userId, request.params.id, body.data, grant);
        } catch (error) {
          const refusal = options.patchRefusal?.(error);
          if (refusal !== undefined) return refuse(reply, 'refused', refusal);
          throw error;
        }
        if (!found) return refuse(reply, 'not-found', 'No such chat.');
        return reply.code(204).send();
      }
    );

    app.get<{ Params: { runId: string } }>(
      '/runs/:runId/events',
      { preHandler: authed },
      async (request, reply) => {
        const { runId } = request.params;
        if (!(await service.owns(request.userId, runId)))
          return refuse(reply, 'not-found', 'No such run.');
        const after = lastEventId(request.headers['last-event-id']);

        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');

        const stream = new AbortController();
        streams.add(stream);
        stream.signal.addEventListener('abort', () => res.end(), { once: true });
        res.on('close', () => stream.abort());
        const keepalive = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs);
        try {
          for await (const { id: eventId, event } of service.events(runId, after, stream.signal)) {
            if (stream.signal.aborted) break;
            res.write(encodeRunEvent(eventId, event));
          }
        } catch (error) {
          // The client reconnects with the last id it read, so a cut stream loses nothing.
          request.log.warn({ err: error, runId }, 'event stream ended early');
        } finally {
          clearInterval(keepalive);
          streams.delete(stream);
          stream.abort();
        }
      }
    );
  };

  app.register(
    async (api) => {
      routes(api);
      options.routes?.(api, { authed, grantFor, refuse });
    },
    { prefix: options.basePath ?? '' }
  );
  return app;
}

/** Fastify logger options that never log a request's headers (they carry the viewer's credentials). */
export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: {
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: request.url,
      }),
    },
  };
}
