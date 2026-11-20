import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { CheckRequest, RemixReplayRequest, clampTimeout } from './contract.ts';
import type { RefusalCode } from './contract.ts';
import {
  MAX_BODY_BYTES,
  MAX_REMIX_SOURCE_BYTES,
  MAX_SOURCE_BYTES,
  REMIX_QUARANTINE_MS,
  SIG_HEADER,
  remixBudgetMs,
} from './limits.ts';
import type { Metrics } from './metrics.ts';
import { BackstopError, PoolClosedError, PoolOverloadedError } from './pool.ts';
import type { HookPool } from './pool.ts';
import { outcomeOf } from './result.ts';
import type { HookResult } from './result.ts';
import type { RunnerMode } from './config.ts';
import { evaluateRemix } from './remix.ts';
import type { RemixReplayResult } from './remix.ts';
import { QuickJSInstance, compileQuickJS } from './sandbox.ts';
import { runRemixSelfTest, runSelfTest } from './selftest.ts';
import type { SelfTestReport } from './selftest.ts';
import { checkTimestamp, sha256Hex, sign, verifySignature } from './signing.ts';

export type AppDeps = {
  secret: string;
  /** The one signed route this process serves; the other is not mounted (404). */
  mode: RunnerMode;
  pool: HookPool;
  metrics: Metrics;
  /** Test seam for the clock; seconds. */
  nowSec?: () => number;
  /** Test seam for the quarantine clock; milliseconds. */
  nowMs?: () => number;
  logger?: boolean;
};

/** The body of every `POST /v1/check` answer, signed in the SIG_HEADER response header. */
export type CheckResponse =
  | { ts: number; req: string; result: HookResult; elapsedMs: number }
  | { ts: number; req: string; error: { code: RefusalCode; message: string } };

/** The body of every `POST /v1/remix/replay` answer: one result per replayed log, in order. */
export type RemixReplayResponse =
  | { ts: number; req: string; results: RemixReplayResult[]; elapsedMs: number }
  | { ts: number; req: string; error: { code: RefusalCode; message: string } };

const STATUS: Record<RefusalCode, number> = {
  bad_signature: 401,
  stale_timestamp: 401,
  bad_request: 400,
  source_too_large: 400,
  sha_mismatch: 400,
  body_too_large: 413,
  overloaded: 503,
  worker_crashed: 500,
  worker_terminated: 500,
  quarantined: 423,
  shutting_down: 503,
};

/** How long a /readyz self-test result is reused. */
const SELF_TEST_TTL_MS = 5_000;

/**
 * Routes:
 *   POST /v1/check  signed hook evaluation (see README "Contract"), in mode `check` only
 *   POST /v1/remix/replay  signed remix app replay (see README "Remix replay"), in mode `remix` only
 *   GET  /healthz   process is up
 *   GET  /readyz    a worker is ready AND the served route's built-in self-test passes
 *
 * The request body is read as raw bytes: the HMAC covers the exact bytes the caller sent, and
 * the signature is checked BEFORE the JSON is parsed. Request bodies, which carry user
 * documents, are never logged.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? (() => performance.now());
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: MAX_BODY_BYTES });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const send = (reply: FastifyReply, status: number, body: CheckResponse | RemixReplayResponse) => {
    const text = JSON.stringify(body);
    return reply
      .code(status)
      .header('content-type', 'application/json')
      .header(SIG_HEADER, sign(deps.secret, text))
      .send(text);
  };
  // `app` is '' until the request has been authenticated and validated: an unauthenticated body
  // must not be able to mint label values. Signature refusals carry no app label for that reason.
  const refuse = (
    reply: FastifyReply,
    req: string,
    code: RefusalCode,
    message: string,
    appId = '',
    detail: { tripped?: boolean } = {}
  ) => {
    if (code === 'bad_signature' || code === 'stale_timestamp') {
      deps.metrics.sigRejected.inc({ reason: code });
    } else {
      deps.metrics.refused.inc({ reason: code, app: appId });
    }
    return send(reply, STATUS[code], { ts: nowSec(), req, error: { code, message, ...detail } });
  };

  app.setErrorHandler((err: { code?: string; statusCode?: number }, _request, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return refuse(reply, '', 'body_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send({ error: { code: err.code ?? 'internal' } });
  });

  // Liveness: the process is up AND the pool has had a ready worker within DEAD_AFTER_MS. A pool
  // whose replacements keep failing to start fails this, so the pod is restarted.
  app.get('/healthz', async (_request, reply) => {
    const l = deps.pool.liveness();
    return reply.code(l.live ? 200 : 503).send({ ok: l.live, readyWorkers: l.ready });
  });

  // Readiness: at least one worker is ready, AND the sandbox self-test passes. The self-test
  // runs on a QuickJS instance of its own on this thread, NOT through the pool, so it never
  // queues behind hook work: an overloaded pool is still a ready pod (overload is answered 503
  // per request). Its result is reused for SELF_TEST_TTL_MS.
  const compiled = compileQuickJS();
  const selfTestInstance = QuickJSInstance.fromCompiled(compiled);
  const runServedSelfTest = () =>
    deps.mode === 'remix'
      ? runRemixSelfTest((args) => evaluateRemix(compiled, args))
      : runSelfTest((args) => selfTestInstance.evaluate(args));
  let selfTest: { at: number; report: Promise<SelfTestReport> } | null = null;
  app.get('/readyz', async (_request, reply) => {
    const now = performance.now();
    if (!selfTest || now - selfTest.at > SELF_TEST_TTL_MS) {
      selfTest = { at: now, report: runServedSelfTest() };
    }
    const report = await selfTest.report;
    const workers = deps.pool.stats().ready > 0;
    const ok = workers && report.ok;
    const body: SelfTestReport = workers ? report : { ok, checks: { ...report.checks, workers } };
    return reply.code(ok ? 200 : 503).send({ ...body, ok });
  });

  /**
   * The checks every signed route makes before it evaluates anything, in this order: the HMAC
   * over the raw bytes, then JSON, the timestamp, the schema, the source cap and its sha256.
   * Either the request, or the refusal already sent.
   */
  const readSigned = <T extends { appId: string; sha256: string; source: string }>(
    request: { body: unknown; headers: Record<string, string | string[] | undefined> },
    reply: FastifyReply,
    schema: z.ZodType<T>,
    maxSourceBytes: number
  ): { req: string; body: T } | { sent: FastifyReply } => {
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) {
      return { sent: refuse(reply, '', 'bad_request', 'content-type must be application/json') };
    }
    const req = sha256Hex(raw);

    if (!verifySignature(deps.secret, raw, request.headers[SIG_HEADER])) {
      return { sent: refuse(reply, req, 'bad_signature', 'signature does not match the body') };
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return { sent: refuse(reply, req, 'bad_request', 'body is not JSON') };
    }
    const ts = checkTimestamp((json as { ts?: unknown } | null)?.ts, nowSec());
    if (!ts.ok) return { sent: refuse(reply, req, 'stale_timestamp', ts.reason) };

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Paths and messages only: never echo values, which may be user documents.
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { sent: refuse(reply, req, 'bad_request', issues) };
    }
    const body = parsed.data;

    const sourceBytes = Buffer.from(body.source, 'utf8');
    if (sourceBytes.length > maxSourceBytes) {
      const message = `source exceeds ${maxSourceBytes} bytes`;
      return { sent: refuse(reply, req, 'source_too_large', message, body.appId) };
    }
    // The runner evaluates only the exact source the approved manifest pinned.
    if (sha256Hex(sourceBytes) !== body.sha256) {
      const message = 'sha256(source) does not match sha256';
      return { sent: refuse(reply, req, 'sha_mismatch', message, body.appId) };
    }
    return { req, body };
  };

  /** A pool rejection as its refusal: each is a runner fault, never an author's. */
  const refusePoolError = (reply: FastifyReply, req: string, appId: string, err: unknown) => {
    if (err instanceof PoolOverloadedError) {
      return refuse(reply, req, 'overloaded', err.message, appId);
    }
    if (err instanceof PoolClosedError) {
      return refuse(reply, req, 'shutting_down', 'runner is shutting down', appId);
    }
    if (err instanceof BackstopError) {
      return refuse(
        reply,
        req,
        'worker_terminated',
        'the call outran the interrupt and its worker was terminated',
        appId
      );
    }
    return refuse(reply, req, 'worker_crashed', 'hook worker failed', appId);
  };

  if (deps.mode === 'check')
    app.post('/v1/check', async (request, reply) => {
      const signed = readSigned(request, reply, CheckRequest, MAX_SOURCE_BYTES);
      if ('sent' in signed) return signed.sent;
      const { req, body } = signed;

      let out;
      try {
        out = await deps.pool.run({
          appId: body.appId,
          source: body.source,
          inputJson: JSON.stringify(body.input),
          timeoutMs: clampTimeout(body.timeoutMs),
        });
      } catch (err) {
        return refusePoolError(reply, req, body.appId, err);
      }

      const outcome = outcomeOf(out.result);
      deps.metrics.calls.inc({
        app: body.appId,
        collection: body.collection,
        op: body.op,
        outcome,
      });
      deps.metrics.duration.observe({ outcome }, out.elapsedMs / 1000);
      return send(reply, 200, { ts: nowSec(), req, result: out.result, elapsedMs: out.elapsedMs });
    });

  // An app whose call outran the interrupt can do it again on every call, and each costs a worker.
  // Keyed by its source too: a new version of the app starts clean.
  const quarantinedUntil = new Map<string, number>();
  const quarantineKey = (appId: string, sha256: string) => `${appId}:${sha256}`;
  const isQuarantined = (key: string) => {
    const until = quarantinedUntil.get(key);
    if (until === undefined) return false;
    if (nowMs() < until) return true;
    quarantinedUntil.delete(key);
    return false;
  };
  // `tripped` marks the one call that started the quarantine: the caller counts trips, never other refusals.
  const refuseQuarantined = (reply: FastifyReply, req: string, appId: string, tripped: boolean) =>
    refuse(
      reply,
      req,
      'quarantined',
      `the app outran the interrupt and its worker was terminated; its calls are refused for ${
        REMIX_QUARANTINE_MS / 60_000
      } minutes`,
      appId,
      { tripped }
    );

  if (deps.mode === 'remix')
    app.post('/v1/remix/replay', async (request, reply) => {
      const signed = readSigned(request, reply, RemixReplayRequest, MAX_REMIX_SOURCE_BYTES);
      if ('sent' in signed) return signed.sent;
      const { req, body } = signed;
      const { source, base, branches = [], autoAnswer } = body.input;
      const logs = [base, ...branches.map((branch) => [...base, ...branch])];

      const key = quarantineKey(body.appId, body.sha256);
      if (isQuarantined(key)) return refuseQuarantined(reply, req, body.appId, false);
      let out;
      try {
        out = await deps.pool.runRemix({
          appId: body.appId,
          source: body.source,
          image: source,
          logs,
          autoAnswer,
          budgetMs: remixBudgetMs(logs.length),
        });
      } catch (err) {
        if (err instanceof BackstopError) {
          // A call admitted before another call tripped the quarantine is the same fault.
          if (isQuarantined(key)) return refuseQuarantined(reply, req, body.appId, false);
          // Expired entries go here too, or apps that tripped once and never called again pile up.
          for (const [k, until] of quarantinedUntil)
            if (nowMs() >= until) quarantinedUntil.delete(k);
          quarantinedUntil.set(key, nowMs() + REMIX_QUARANTINE_MS);
          return refuseQuarantined(reply, req, body.appId, true);
        }
        return refusePoolError(reply, req, body.appId, err);
      }

      for (const result of out.results) {
        const outcome = 'cause' in result ? result.cause : result.done ? 'done' : 'effect';
        deps.metrics.calls.inc({ app: body.appId, collection: 'remix', op: 'replay', outcome });
      }
      return send(reply, 200, {
        ts: nowSec(),
        req,
        results: out.results,
        elapsedMs: out.elapsedMs,
      });
    });

  return app;
}
