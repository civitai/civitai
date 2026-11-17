import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import {
  BACKSTOP_MS,
  MAX_BODY_BYTES,
  MAX_SOURCE_BYTES,
  SIG_HEADER,
  SIG_SKEW_SECONDS,
} from '../limits.ts';
import { createMetrics } from '../metrics.ts';
import type { Metrics } from '../metrics.ts';
import { HookPool } from '../pool.ts';
import { SECRET, checkBody, hmac, sha256, waitFor } from '../test-support/fixtures.ts';

/** `POST /v1/check` through the real Fastify app and the real worker pool. */

const ALLOW = 'export default function check() { return { allow: true }; }';
const DENY_LOCKED =
  'export default function check(i) { return i.before && i.before.locked ? { allow: false, reason: i.op + ": card is locked" } : { allow: true }; }';
const LOOP = 'export default function check() { for (;;) {} }';
const STALL =
  'export default function check() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }';

let pool: HookPool;
let metrics: Metrics;
let app: FastifyInstance;

beforeAll(async () => {
  metrics = createMetrics();
  pool = await HookPool.start({
    size: 2,
    onBackstop: (appId) => metrics.workerTerminated.inc({ app: appId }),
  });
  metrics.attachPool(pool);
  app = buildApp({ secret: SECRET, pool, metrics });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.close();
});

function post(body: string, sig: string | null = hmac(SECRET, body)) {
  return app.inject({
    method: 'POST',
    url: '/v1/check',
    headers: { 'content-type': 'application/json', ...(sig === null ? {} : { [SIG_HEADER]: sig }) },
    payload: body,
  });
}

async function metricValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const m = (await metrics.registry.getMetricsAsJSON()).find((x) => x.name === name);
  const v = (m?.values ?? []).find((x) =>
    Object.entries(labels).every(([k, val]) => (x.labels as Record<string, unknown>)[k] === val)
  );
  return v ? Number(v.value) : 0;
}

describe('POST /v1/check: results', () => {
  it('answers 200 with an allow, and the response is signed and bound to the request', async () => {
    const body = JSON.stringify(checkBody(ALLOW));
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.result).toEqual({ allow: true });
    expect(json.req).toBe(sha256(body));
    expect(Math.abs(json.ts - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(res.headers[SIG_HEADER]).toBe(hmac(SECRET, res.body));
    // Negative control on the response signature: another secret does not verify it.
    expect(res.headers[SIG_HEADER]).not.toBe(hmac(`${SECRET}x`, res.body));
  });

  it('answers 200 with a deny and the reason', async () => {
    const res = await post(
      JSON.stringify(
        checkBody(DENY_LOCKED, { input: { op: 'delete', after: null, before: { locked: true } } })
      )
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      allow: false,
      cause: 'denied',
      reason: 'delete: card is locked',
    });
  });

  it('answers 200 with cause timeout for a loop, and counts it by outcome', async () => {
    const before = await metricValue('storage_hook_runner_calls_total', { outcome: 'timeout' });
    const res = await post(JSON.stringify(checkBody(LOOP, { timeoutMs: 10 })));
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
    expect(await metricValue('storage_hook_runner_calls_total', { outcome: 'timeout' })).toBe(
      before + 1
    );
  });

  // The upper bounds below only say the deadline is not far too late. They sit well under the
  // worker backstop (which would answer 500 instead), not near the deadline, so CI load cannot
  // turn them red.
  it('clamps timeoutMs to the 500 ms maximum', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP, { timeoutMs: 60_000 })));
    expect(res.json().result).toMatchObject({ cause: 'timeout' });
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(500);
    expect(res.json().elapsedMs).toBeLessThan(500 + BACKSTOP_MS / 2);
  });

  it('clamps timeoutMs to the 1 ms minimum', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP, { timeoutMs: 0 })));
    expect(res.json().result).toMatchObject({ cause: 'timeout' });
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(1);
    expect(res.json().elapsedMs).toBeLessThan(1 + BACKSTOP_MS / 2);
  });

  it('defaults timeoutMs to 50 ms', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP)));
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(50);
    expect(res.json().elapsedMs).toBeLessThan(50 + BACKSTOP_MS / 2);
  });
});

describe('POST /v1/check: sha256 pin', () => {
  it('refuses 400 sha_mismatch when the source does not hash to sha256', async () => {
    const res = await post(JSON.stringify(checkBody(ALLOW, { sha256: sha256(`${ALLOW} `) })));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('sha_mismatch');
    expect(res.headers[SIG_HEADER]).toBe(hmac(SECRET, res.body));
  });

  it('refuses a one-character source change under the original sha', async () => {
    const body = checkBody(ALLOW);
    body.source = ALLOW.replace('true', 'false');
    const res = await post(JSON.stringify(body));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('sha_mismatch');
  });

  it('hashes the source as UTF-8 (a non-ASCII source with its UTF-8 sha is accepted)', async () => {
    const src =
      'export default function check() { return { allow: false, reason: "verrouillé ✓" }; }';
    const res = await post(JSON.stringify(checkBody(src)));
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ allow: false, cause: 'denied', reason: 'verrouillé ✓' });
  });

  it('refuses a source over the size cap', async () => {
    const src = `${ALLOW}\n//${'x'.repeat(MAX_SOURCE_BYTES)}`;
    const res = await post(JSON.stringify(checkBody(src)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('source_too_large');
  });
});

describe('POST /v1/check: signature and replay window', () => {
  it('refuses 401 with no signature header', async () => {
    const res = await post(JSON.stringify(checkBody(ALLOW)), null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('bad_signature');
  });

  it('refuses 401 with a signature made with another secret', async () => {
    const body = JSON.stringify(checkBody(ALLOW));
    const res = await post(body, hmac('another-secret-0123456789abcdef0123', body));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('bad_signature');
  });

  it('refuses 401 when the body was changed after signing', async () => {
    const body = JSON.stringify(checkBody(ALLOW));
    const res = await post(body.replace('"put"', '"create"'), hmac(SECRET, body));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('bad_signature');
  });

  it('refuses 401 with a malformed signature', async () => {
    const res = await post(JSON.stringify(checkBody(ALLOW)), 'zz');
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['too old', -(SIG_SKEW_SECONDS + 1)],
    ['too far ahead', SIG_SKEW_SECONDS + 1],
  ])('refuses 401 stale_timestamp when ts is %s', async (_label, offset) => {
    const ts = Math.floor(Date.now() / 1000) + offset;
    const res = await post(JSON.stringify(checkBody(ALLOW, { ts })));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('stale_timestamp');
  });

  // Wall clock on both sides, so not the exact edge; checkTimestamp's unit test pins that.
  it('accepts ts just inside the window', async () => {
    const ts = Math.floor(Date.now() / 1000) - (SIG_SKEW_SECONDS - 2);
    const res = await post(JSON.stringify(checkBody(ALLOW, { ts })));
    expect(res.statusCode).toBe(200);
  });

  it('refuses 401 when ts is missing', async () => {
    const { ts: _ts, ...rest } = checkBody(ALLOW);
    const res = await post(JSON.stringify(rest));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('stale_timestamp');
  });

  it('counts signature refusals', async () => {
    const before = await metricValue('storage_hook_runner_sig_rejected_total', {
      reason: 'bad_signature',
    });
    await post(JSON.stringify(checkBody(ALLOW)), 'a'.repeat(64));
    expect(
      await metricValue('storage_hook_runner_sig_rejected_total', { reason: 'bad_signature' })
    ).toBe(before + 1);
  });
});

describe('POST /v1/check: request shape', () => {
  it('refuses 400 an unknown top-level field', async () => {
    const res = await post(JSON.stringify({ ...checkBody(ALLOW), extra: 1 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('refuses 400 an input missing `before` (null must be sent, not omitted)', async () => {
    const body = checkBody(ALLOW) as Record<string, unknown> & { input: Record<string, unknown> };
    delete body.input.before;
    const res = await post(JSON.stringify(body));
    expect(res.statusCode).toBe(400);
  });

  it('refuses 400 when input.op disagrees with op', async () => {
    const body = { ...checkBody(ALLOW), op: 'delete' };
    const res = await post(JSON.stringify(body));
    expect(res.statusCode).toBe(400);
  });

  it('does not echo document values in a 400 message', async () => {
    const body = checkBody(ALLOW, {
      input: { viewer: { userId: 'secret-value-xyz' as unknown as number } },
    });
    const res = await post(JSON.stringify(body));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('secret-value-xyz');
  });

  it('refuses 413 a body over the cap', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) });
    const res = await post(body);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('body_too_large');
  });
});

describe('health', () => {
  it('/healthz is 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('/readyz is 200 and reports every self-test passing', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { allow: true, deny: true, interrupt: true } });
  });

  // Readiness must not queue behind hook work: an overloaded pool is still a ready pod.
  it('/readyz stays 200 while the pool is saturated', async () => {
    const m = createMetrics();
    const p = await HookPool.start({ size: 1, maxQueue: 1, maxPerApp: 8 });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      const slow = JSON.stringify(checkBody(LOOP, { timeoutMs: 300 }));
      const inflight = [post2(a, slow), post2(a, slow)]; // one running, one queued: queue full
      await waitFor('one call running and one queued', () => {
        const s = p.stats();
        return s.busy === 1 && s.queued === 1;
      });
      const res = await a.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        checks: { allow: true, deny: true, interrupt: true },
      });
      // Still saturated when /readyz answered, so it did not wait for the pool.
      expect(p.stats()).toMatchObject({ busy: 1, queued: 1 });
      await Promise.all(inflight);
    } finally {
      await a.close();
      await p.close();
    }
  });

  it('/healthz is 503 when the pool has had no live worker for deadAfterMs', async () => {
    const m = createMetrics();
    let made = 0;
    const crash = new URL('../test-support/crash-worker.mjs', import.meta.url);
    const p = await HookPool.start({
      size: 1,
      backstopMs: 20,
      respawnBaseMs: 10,
      deadAfterMs: 50,
      createWorker: (url) => new Worker(made++ === 0 ? url : crash),
    });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      const res = await post2(a, JSON.stringify(checkBody(STALL, { timeoutMs: 10 })));
      expect(res.statusCode).toBe(500);
      await waitFor('the pool to report not live', () => !p.liveness().live);
      expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503);
    } finally {
      await a.close();
      await p.close();
    }
  });

  it('/readyz is 503 once the pool is closed', async () => {
    const m = createMetrics();
    const p = await HookPool.start({ size: 1 });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    await p.close();
    const res = await a.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().ok).toBe(false);
    await a.close();
  });
});

describe('runner faults are not blamed on the author', () => {
  it('a backstop termination answers 500 worker_terminated and is counted per app', async () => {
    const m = createMetrics();
    const p = await HookPool.start({
      size: 1,
      backstopMs: 20,
      onBackstop: (appId) => m.workerTerminated.inc({ app: appId }),
    });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      const res = await post2(a, JSON.stringify(checkBody(STALL, { timeoutMs: 10 })));
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('worker_terminated');
      expect(res.headers[SIG_HEADER]).toBe(hmac(SECRET, res.body));
      const json = await m.registry.getMetricsAsJSON();
      const value = (name: string, labels: Record<string, string>) =>
        Number(
          json
            .find((x) => x.name === name)
            ?.values.find((v) =>
              Object.entries(labels).every(
                ([k, val]) => (v.labels as Record<string, unknown>)[k] === val
              )
            )?.value ?? 0
        );
      expect(
        value('storage_hook_runner_worker_terminated_total', { app: 'app-storage-demo' })
      ).toBe(1);
      expect(
        value('storage_hook_runner_requests_refused_total', {
          reason: 'worker_terminated',
          app: 'app-storage-demo',
        })
      ).toBe(1);
    } finally {
      await a.close();
      await p.close();
    }
  });
});

describe('per-app fairness over HTTP', () => {
  it('app A at its cap gets 503 overloaded while app B is answered', async () => {
    const m = createMetrics();
    const p = await HookPool.start({ size: 1, maxQueue: 8, maxPerApp: 2 });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      const slowA = JSON.stringify(checkBody(LOOP, { timeoutMs: 100 }));
      const inflight = [post2(a, slowA), post2(a, slowA)];
      await waitFor('one call running and one queued', () => {
        const s = p.stats();
        return s.busy === 1 && s.queued === 1;
      });
      const a3 = await post2(a, JSON.stringify(checkBody(ALLOW)));
      expect(a3.statusCode).toBe(503);
      expect(a3.json().error.code).toBe('overloaded');
      const b = await post2(
        a,
        JSON.stringify(checkBody(ALLOW, { input: { app: { blockId: 'app-b' } } }))
      );
      expect(b.statusCode).toBe(200);
      expect(b.json().result).toEqual({ allow: true });
      await Promise.all(inflight);
    } finally {
      await a.close();
      await p.close();
    }
  });
});

describe('overload', () => {
  it('answers 503 overloaded once the queue is full', async () => {
    const m = createMetrics();
    const p = await HookPool.start({ size: 1, maxQueue: 1, maxPerApp: 8 });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      const slow = JSON.stringify(checkBody(LOOP, { timeoutMs: 200 }));
      const inflight = [post2(a, slow), post2(a, slow)]; // one running, one queued
      await waitFor('one call running and one queued', () => {
        const s = p.stats();
        return s.busy === 1 && s.queued === 1;
      });
      const res = await post2(a, JSON.stringify(checkBody(ALLOW)));
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('overloaded');
      const done = await Promise.all(inflight);
      expect(done.map((d) => d.statusCode)).toEqual([200, 200]);
    } finally {
      await a.close();
      await p.close();
    }
  });
});

function post2(a: FastifyInstance, body: string) {
  return a.inject({
    method: 'POST',
    url: '/v1/check',
    headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
    payload: body,
  });
}
