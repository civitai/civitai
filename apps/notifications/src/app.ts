import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  cleanupNotificationsInput,
  countNotificationsInput,
  createNotificationPendingRow,
  createNotificationsBulkInput,
  markReadInput,
  notificationExistsInput,
  queryNotificationsInput,
} from '@civitai/notifications';
import { register, producerRequestsTotal, httpRequestDurationSeconds } from './lib/server/metrics';
import { isAuthorized } from './lib/server/auth';
import { createNotification } from './lib/server/create';
import {
  cleanupNotifications,
  countNotifications,
  createNotificationsBulk,
  markNotificationsRead,
  notificationExists,
  queryNotifications,
} from './lib/server/operations';
import { notifDbRead, notifDbWrite } from './lib/server/clients/db';
import { logLevel } from './env';

/**
 * Build the Fastify server (no listen — server.ts calls listen; tests use `.inject`). Ops routes:
 *   - GET  /health      — no-dep liveness+readiness (must not touch DB/redis so it can't flap).
 *   - GET  /pool-stats  — notif pool snapshots.
 *   - GET  /metrics     — Prometheus scrape, private-by-XFF.
 * Authed producer/read API (A + C), all shared-secret gated, all POST — the trusted caller (the monolith)
 * passes the resolved userId; the app does not re-auth the end user:
 *   - POST /notifications         — settings-filtered single create.
 *   - POST /notifications/bulk    — pre-resolved bulk create (no opt-out filter).
 *   - POST /notifications/query   — base rows for a user (unenriched).
 *   - POST /notifications/count   — per-category counts.
 *   - POST /notifications/mark-read — mark one/all/category read (fire-and-forget).
 *   - POST /notifications/exists  — producer-side key dedup.
 *   - POST /notifications/cleanup — delete old UserNotification rows.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: logLevel },
    trustProxy: true,
    // Raised from Fastify's 1MB default: a bulk-create batch (bounded to 1000 rows client-side) can still
    // carry large `users[]` arrays per row. The client chunks by row count; this bounds the worst case.
    bodyLimit: 25 * 1024 * 1024,
  });

  // RED for the authed API. One onResponse hook records duration+count+outcome for every /notifications*
  // route uniformly (query/count/mark-read/bulk/exists/cleanup previously had NO metric). Scoped to the
  // authed API paths so the ops routes (/health, /metrics, /pool-stats) don't pollute the RED view.
  // `routeOptions.url` is the static route template (bounded label); skip when undefined (404s).
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route || !route.startsWith('/notifications')) return;
    const status = reply.statusCode;
    const outcome =
      status < 400
        ? 'success'
        : status === 401
          ? 'unauthorized'
          : status === 400
            ? 'rejected'
            : status >= 500
              ? 'error'
              : 'client_error';
    httpRequestDurationSeconds.observe({ route, outcome }, reply.elapsedTime / 1000);
  });

  app.get('/health', async () => ({ status: 'ok', service: 'notifications' }));

  app.get('/pool-stats', async () => {
    const snapshot = (pool: ReturnType<typeof notifDbWrite>) => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      active: pool.totalCount - pool.idleCount,
      waiting: pool.waitingCount,
    });
    return { write: snapshot(notifDbWrite()), read: snapshot(notifDbRead()), timestamp: Date.now() };
  });

  // EXPOSURE GUARD: any request carrying x-forwarded-for came through the public ingress; the in-cluster
  // ServiceMonitor scrapes the Pod IP directly with NO XFF. So XFF present ⇒ 404.
  app.get('/metrics', async (req, reply) => {
    if (req.headers['x-forwarded-for'] !== undefined) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    reply.header('content-type', register.contentType);
    return register.metrics();
  });

  // Shared gate + zod validation for every authed POST. Returns the parsed body, or null after having
  // already sent the 401/400 response.
  function authedBody<T>(schema: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
    if (!isAuthorized(req.headers)) {
      producerRequestsTotal.inc({ outcome: 'unauthorized' });
      reply.code(401).send({ error: 'Unauthorized' });
      return null;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      producerRequestsTotal.inc({ outcome: 'rejected' });
      reply.code(400).send({ error: 'Invalid payload', issues: parsed.error.issues });
      return null;
    }
    return parsed.data;
  }

  app.post('/notifications', async (req, reply) => {
    const body = authedBody(createNotificationPendingRow, req, reply);
    if (!body) return reply;
    try {
      const result = await createNotification(body);
      producerRequestsTotal.inc({ outcome: 'created' });
      return reply.code(202).send({ status: 'queued', queued: result.queued });
    } catch (err) {
      producerRequestsTotal.inc({ outcome: 'error' });
      req.log.error({ err }, 'producer create failed');
      return reply.code(500).send({ error: 'Internal error' });
    }
  });

  app.post('/notifications/bulk', async (req, reply) => {
    const body = authedBody(createNotificationsBulkInput, req, reply);
    if (!body) return reply;
    try {
      await createNotificationsBulk(body);
      producerRequestsTotal.inc({ outcome: 'created' });
      return reply.code(202).send({ status: 'queued', queued: body.length });
    } catch (err) {
      producerRequestsTotal.inc({ outcome: 'error' });
      req.log.error({ err }, 'bulk create failed');
      return reply.code(500).send({ error: 'Internal error' });
    }
  });

  app.post('/notifications/query', async (req, reply) => {
    const body = authedBody(queryNotificationsInput, req, reply);
    if (!body) return reply;
    const items = await queryNotifications({ ...body, limit: body.limit ?? 100 });
    return reply.send(items);
  });

  app.post('/notifications/count', async (req, reply) => {
    const body = authedBody(countNotificationsInput, req, reply);
    if (!body) return reply;
    const counts = await countNotifications(body);
    return reply.send(counts);
  });

  app.post('/notifications/mark-read', async (req, reply) => {
    const body = authedBody(markReadInput, req, reply);
    if (!body) return reply;
    // Fire-and-forget: enqueue the write and ack immediately (the caller's UI is already optimistic).
    markNotificationsRead(body);
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/notifications/exists', async (req, reply) => {
    const body = authedBody(notificationExistsInput, req, reply);
    if (!body) return reply;
    return reply.send({ exists: await notificationExists(body.key) });
  });

  app.post('/notifications/cleanup', async (req, reply) => {
    const body = authedBody(cleanupNotificationsInput, req, reply);
    if (!body) return reply;
    const deleted = await cleanupNotifications(body.before);
    return reply.send({ deleted });
  });

  return app;
}
