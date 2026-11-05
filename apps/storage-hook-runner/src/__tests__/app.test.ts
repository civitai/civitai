import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { MAX_BODY_BYTES, MAX_SOURCE_BYTES, SIG_HEADER, SIG_SKEW_SECONDS } from '../limits.ts';
import { createMetrics } from '../metrics.ts';
import type { Metrics } from '../metrics.ts';
import { HookPool } from '../pool.ts';
import { SECRET, checkBody, hmac, sha256 } from '../test-support/fixtures.ts';

/** `POST /v1/check` through the real Fastify app and the real worker pool. */

const ALLOW = 'export default function check() { return { allow: true }; }';
const DENY_LOCKED =
  'export default function check(i) { return i.before && i.before.locked ? { allow: false, reason: i.op + ": card is locked" } : { allow: true }; }';
const LOOP = 'export default function check() { for (;;) {} }';

let pool: HookPool;
let metrics: Metrics;
let app: FastifyInstance;

beforeAll(async () => {
  metrics = createMetrics();
  pool = await HookPool.start({ size: 2, onBackstop: () => metrics.workerTerminated.inc() });
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

  it('clamps timeoutMs to the 500 ms maximum', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP, { timeoutMs: 60_000 })));
    expect(res.json().result).toMatchObject({ cause: 'timeout' });
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(500);
    expect(res.json().elapsedMs).toBeLessThan(600);
  });

  it('clamps timeoutMs to the 1 ms minimum', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP, { timeoutMs: 0 })));
    expect(res.json().result).toMatchObject({ cause: 'timeout' });
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(1);
    expect(res.json().elapsedMs).toBeLessThan(40);
  });

  it('defaults timeoutMs to 50 ms', async () => {
    const res = await post(JSON.stringify(checkBody(LOOP)));
    expect(res.json().elapsedMs).toBeGreaterThanOrEqual(50);
    expect(res.json().elapsedMs).toBeLessThan(90);
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

  it('accepts ts at the edge of the window', async () => {
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

describe('overload', () => {
  it('answers 503 overloaded once the queue is full', async () => {
    const m = createMetrics();
    const p = await HookPool.start({ size: 1, maxQueue: 1 });
    const a = buildApp({ secret: SECRET, pool: p, metrics: m });
    try {
      const slow = JSON.stringify(checkBody(LOOP, { timeoutMs: 200 }));
      const inflight = [post2(a, slow), post2(a, slow)]; // one running, one queued
      await new Promise((r) => setTimeout(r, 20));
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
