import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  cleanupNotificationsInput,
  countNotificationsInput,
  createNotificationPendingRow,
  createNotificationsBulkInput,
  getSystemNoticeSendInput,
  markReadInput,
  notificationExistsInput,
  queryNotificationsInput,
  sendSystemNoticesInput,
} from '@civitai/notifications';
import { register, producerRequestsTotal, httpRequestDurationSeconds } from './lib/server/metrics';
import { isAuthorized, isNoticesAuthorized } from './lib/server/auth';
import { logToAxiom } from './lib/server/clients/axiom';
import { getSystemNoticeSend, NoticeError, sendSystemNotices } from './lib/server/notices';
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
import { health } from './lib/server/health';
import { logLevel } from './env';

/**
 * Build the Fastify server (no listen — server.ts calls listen; tests use `.inject`). Ops routes:
 *   - GET  /health      — liveness+readiness. Never touches DB/redis itself; on a worker pod it returns
 *                         503 when the worker's observed redis or poll-loop state says it is stuck.
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
 * System notices, gated by their own token (NOTIFICATIONS_NOTICES_TOKEN), never the producer one:
 *   - POST /notifications/notices     — dry-run or send a system notice to a list of users.
 *   - POST /notifications/notices/get — the audit record for one sendId.
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
    // outcome is derived purely from the HTTP status class, so a 2xx ⇒ "success" means the request was
    // ACCEPTED, not that any downstream work completed. For fire-and-forget routes (e.g. mark-read's 202)
    // "success" is the ACK; a later async write failure is invisible here (see the mark-read route note).
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

  app.get('/health', async (_req, reply) => {
    const report = health.check();
    if (report.ok) return { status: 'ok', service: 'notifications' };
    return reply
      .code(503)
      .send({ status: 'unhealthy', service: 'notifications', reasons: report.reasons });
  });

  app.get('/pool-stats', async () => {
    const snapshot = (pool: ReturnType<typeof notifDbWrite>) => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      active: pool.totalCount - pool.idleCount,
      waiting: pool.waitingCount,
    });
    return {
      write: snapshot(notifDbWrite()),
      read: snapshot(notifDbRead()),
      timestamp: Date.now(),
    };
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
    // NOTE: the 202 ACK means "accepted", not "written". The RED histogram therefore records this as
    // outcome="success" for the ACK regardless of whether the async DB write later fails — a failed
    // write does NOT surface here. This metric is request-acceptance RED, not delivery confirmation.
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

  function noticesBody<T>(schema: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
    if (!isNoticesAuthorized(req.headers)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return null;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid payload', issues: parsed.error.issues });
      return null;
    }
    return parsed.data;
  }

  app.post('/notifications/notices', async (req, reply) => {
    const body = noticesBody(sendSystemNoticesInput, req, reply);
    if (!body) return reply;
    const credential = 'notices-token' as const;
    const audit = {
      name: 'system-notices',
      sendId: body.sendId,
      mode: body.mode,
      noticeType: body.type,
      sentBy: body.sentBy,
      reason: body.reason,
      credential,
    };
    try {
      const result = await sendSystemNotices(body, credential);
      logToAxiom({
        type: 'info',
        ...audit,
        status: 200,
        requested: result.requested,
        ...result.counts,
      }).catch(() => undefined);
      return reply.send(result);
    } catch (err) {
      const status = err instanceof NoticeError ? err.status : 500;
      const extra = err instanceof NoticeError ? err.extra : {};
      const message = (err as Error).message;
      logToAxiom({
        type: status >= 500 ? 'error' : 'warning',
        ...audit,
        status,
        message,
        ...extra,
      }).catch(() => undefined);
      if (status >= 500) req.log.error({ err }, 'system notices failed');
      return reply.code(status).send({ error: message, ...extra });
    }
  });

  app.post('/notifications/notices/get', async (req, reply) => {
    const body = noticesBody(getSystemNoticeSendInput, req, reply);
    if (!body) return reply;
    const record = await getSystemNoticeSend(body.sendId);
    if (!record) return reply.code(404).send({ error: 'Unknown sendId' });
    return reply.send(record);
  });

  return app;
}
