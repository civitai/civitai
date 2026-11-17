import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { SIG_HEADER } from '../limits.ts';
import { createMetrics } from '../metrics.ts';
import { HookPool } from '../pool.ts';
import { QuickJSInstance, compileQuickJS, evaluateHookOn, instantiate } from '../sandbox.ts';
import { SECRET, checkBody, hmac, hookInputJson } from '../test-support/fixtures.ts';

/**
 * Per-call cost, printed as `BENCH ...` lines for the PR record. It asserts only that every
 * call answered correctly: timing on a shared CI runner is a measurement, not a gate.
 *
 * OPT-IN: skipped unless RUNNER_BENCH=1, so it costs the CI suite nothing. Run it with
 *   RUNNER_BENCH=1 pnpm --filter @civitai/storage-hook-runner-app exec vitest run src/__tests__/benchmark.test.ts
 *
 * Measured:
 *   - in-process, fresh runtime per call in a shared instance (what the runner does) vs a fresh
 *     WASM instance per call (the stronger isolation it does not use), at 1 KiB and 64 KiB hooks;
 *   - end to end through Fastify (HMAC verify + sha256 + pool + worker + response signing).
 */

const N = 200;

function hookOfSize(bytes: number): string {
  const head =
    'export default function check(i) { return i.before && i.before.locked ? { allow: false, reason: "locked" } : { allow: TABLE.length > 0 }; }\n';
  const rows: string[] = [];
  let size = head.length + 'const TABLE = [];\n'.length;
  for (let n = 0; size < bytes - 40; n++) {
    const row = `"rule-${n}-${'r'.repeat(20)}",`;
    rows.push(row);
    size += row.length;
  }
  const src = `const TABLE = [${rows.join('')}];\n${head}`;
  return src;
}

const HOOKS = { '1KiB': hookOfSize(1024), '64KiB': hookOfSize(64 * 1024 - 256) };

function pct(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { p50: at(0.5).toFixed(3), p99: at(0.99).toFixed(3), max: s[s.length - 1].toFixed(3) };
}

function report(label: string, samples: number[]) {
  // eslint-disable-next-line no-console
  console.log(`BENCH ${label} n=${samples.length} ${JSON.stringify(pct(samples))} ms`);
}

describe.skipIf(process.env.RUNNER_BENCH !== '1')('benchmark (opt-in: RUNNER_BENCH=1)', () => {
  const input = hookInputJson();

  it('sizes the fixtures as named', () => {
    expect(Buffer.byteLength(HOOKS['1KiB'])).toBeGreaterThan(900);
    expect(Buffer.byteLength(HOOKS['1KiB'])).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(HOOKS['64KiB'])).toBeGreaterThan(60 * 1024);
    expect(Buffer.byteLength(HOOKS['64KiB'])).toBeLessThanOrEqual(64 * 1024);
  });

  for (const [name, source] of Object.entries(HOOKS)) {
    it(`in-process, ${name}: runtime-per-call vs instance-per-call`, async () => {
      const compiled = compileQuickJS();
      const shared = QuickJSInstance.fromCompiled(compiled);
      const perRuntime: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        const out = await shared.evaluate({ source, inputJson: input, timeoutMs: 500 });
        perRuntime.push(performance.now() - t);
        expect(out.result).toEqual({ allow: true });
      }
      const perInstance: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        const out = evaluateHookOn(await instantiate(compiled), {
          source,
          inputJson: input,
          timeoutMs: 500,
        });
        perInstance.push(performance.now() - t);
        expect(out.result).toEqual({ allow: true });
      }
      report(`in-process runtime-per-call ${name}`, perRuntime);
      report(`in-process instance-per-call ${name}`, perInstance);
    });
  }

  describe('end to end over HTTP (app.inject, pool of 1)', () => {
    let pool: HookPool;
    let app: FastifyInstance;
    beforeAll(async () => {
      pool = await HookPool.start({ size: 1 });
      app = buildApp({ secret: SECRET, pool, metrics: createMetrics() });
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
      await pool.close();
    });

    for (const [name, source] of Object.entries(HOOKS)) {
      it(`POST /v1/check, ${name}`, async () => {
        const samples: number[] = [];
        for (let i = 0; i < N; i++) {
          const body = JSON.stringify(checkBody(source, { timeoutMs: 500 }));
          const t = performance.now();
          const res = await app.inject({
            method: 'POST',
            url: '/v1/check',
            headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
            payload: body,
          });
          samples.push(performance.now() - t);
          expect(res.json().result).toEqual({ allow: true });
        }
        report(`http end-to-end ${name}`, samples);
      });
    }
  });
});
