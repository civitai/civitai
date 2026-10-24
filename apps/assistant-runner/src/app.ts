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

import type { PreviewRestarts, RestartErrorCode } from './app-assistant/preview-restart';
import type { Authenticator } from './interfaces';
import { MintRefusedError } from './minter';
import type { RunService } from './service';
import { GRANT_HEADER, grantHeader, type TokenVerifier, type VerifiedGrant } from './tokens';
import { refuseAll, refuseGrants } from './unconfigured';

export interface AppOptions {
  service: RunService;
  /** Who a request acts for. Without one every run-API request is refused. */
  authenticator?: Authenticator;
  /** Checks the run grant a start (or a patch) carries. Without one every start is refused. */
  grants?: Pick<TokenVerifier, 'grant'>;
  /** The page's Restart preview (`POST apps/:app/preview`). Without it that answers 503. */
  previews?: PreviewRestarts;
  /** The path the run API is served under (`RUNNER_BASE_PATH`); `''` for the root. */
  basePath?: string;
  logger?: FastifyServerOptions['logger'];
  /** How often an open event stream gets a comment, so the client can tell a quiet run from a dead connection. */
  keepaliveMs?: number;
}

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

/** What each refused Restart preview answers with. */
const RESTART_STATUS: Record<RestartErrorCode, number> = {
  refused: 403,
  'not-found': 404,
  'not-running': 409,
  'rate-limited': 429,
  failed: 502,
  unavailable: 503,
};

const stopBody = z.object({ v: z.literal(1) });
const previewBody = z.object({ v: z.literal(1) });
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

export function buildApp(options: AppOptions): FastifyInstance {
  const { service } = options;
  const authenticator = options.authenticator ?? refuseAll;
  const grants = options.grants ?? refuseGrants;
  const keepaliveMs = options.keepaliveMs ?? Math.floor((RUN_KEEPALIVE_MS * 2) / 3);
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
  ): Promise<VerifiedGrant | null> => {
    const token = grantHeader(request.headers);
    const grant = token ? await grants.grant(token) : null;
    if (
      !grant ||
      grant.preview !== preview ||
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
      return reply.code(201).send(outcome.response);
    });

    app.get('/runs', { preHandler: authed }, async (request, reply) => {
      const conversationId = (request.query as Record<string, unknown>).conversationId;
      if (typeof conversationId !== 'string' || !conversationId)
        return refuse(reply, 'bad-request', 'conversationId is required.');
      return { v: 1, run: await service.lookup(request.userId, conversationId) };
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
        // Optional here: without one the store acts with a live run's grant for this chat.
        let grant: VerifiedGrant | undefined;
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
          // No grant to write it with (none sent, no run of the chat live): the client's to fix.
          if (error instanceof MintRefusedError && error.code === 'invalid_grant')
            return refuse(
              reply,
              'refused',
              `This chat needs a current run grant in ${GRANT_HEADER} to be changed now.`
            );
          // The user is refused, or turned the assistant off: the same answer the run would get.
          if (
            error instanceof MintRefusedError &&
            (error.code === 'refused' || error.code === 'consent_required')
          )
            return refuse(reply, 'refused', error.message);
          throw error;
        }
        if (!found) return refuse(reply, 'not-found', 'No such chat.');
        return reply.code(204).send();
      }
    );

    // The page's Restart preview: opens the app's live preview again with no reply (no model call,
    // no Buzz), after a reload found none live. Answers the block and host shown, never the tunnel's
    // id. Needs a preview grant for this app (`X-Run-Grant`), which civitai signs for the viewer.
    app.post<{ Params: { app: string } }>(
      '/apps/:app/preview',
      { preHandler: authed },
      async (request, reply) => {
        if (!previewBody.safeParse(request.body ?? { v: 1 }).success)
          return refuse(reply, 'bad-request', 'The restart request is not one this runner reads.');
        const { previews } = options;
        if (!previews) return refuse(reply, 'unavailable', 'The live preview is not set up here.');
        const appKey = request.params.app;
        const conversation = previews.grantConversation(appKey);
        if (!conversation) return refuse(reply, 'bad-request', 'That is not an app key.');
        const grant = await grantFor(request, conversation, undefined, true);
        if (!grant)
          return refuse(
            reply,
            'refused',
            `This restart needs a current preview grant for this app in ${GRANT_HEADER}.`
          );
        const outcome = await previews.restart(request.userId, appKey, grant.token);
        if (outcome.ok) return { v: 1, blockId: outcome.blockId, host: outcome.host };
        return reply
          .code(RESTART_STATUS[outcome.error])
          .send({ v: 1, error: outcome.error, message: outcome.message });
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

  app.register(async (api) => routes(api), { prefix: options.basePath ?? '' });
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
