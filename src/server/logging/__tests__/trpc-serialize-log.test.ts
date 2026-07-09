import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __flushPendingEmitsForTest,
  __rateGateForTest,
  __resetConfigCacheForTests,
  __resetRateLimitForTests,
  __setEmitSinkForTests,
  instrumentSerialize,
  resolveSerializeConfig,
  runWithSerializeCtx,
  serializeCtxFromRequest,
  shouldLogSerialize,
  type SerializeLogPayload,
} from '~/server/logging/trpc-serialize-log';

// Env keys this module reads — snapshot + restore around every test so cases can
// tune thresholds without leaking into siblings.
const ENV_KEYS = [
  'TRPC_SERIALIZE_LOG_ENABLED',
  'TRPC_SERIALIZE_SLOW_MS',
  'TRPC_SERIALIZE_OVERSIZED_BYTES',
  'TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS',
  'TRPC_SERIALIZE_LOG_MAX_PER_SEC',
] as const;

describe('trpc-serialize-log', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    __resetRateLimitForTests();
    __resetConfigCacheForTests(); // module-level config cache must not leak across tests
    __setEmitSinkForTests(undefined);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    __setEmitSinkForTests(undefined);
    vi.restoreAllMocks(); // undo any performance.now spy
  });

  describe('shouldLogSerialize (pure trigger decision)', () => {
    const base = { serializeMs: 0, bytes: 0, slowMs: 250, oversizedBytes: 1024 * 1024 };

    it('fires when serialize duration is at/above the slow threshold', () => {
      expect(shouldLogSerialize({ ...base, serializeMs: 250 })).toBe(true);
      expect(shouldLogSerialize({ ...base, serializeMs: 6000 })).toBe(true);
    });

    it('fires when byte size is at/above the oversized threshold (even if fast)', () => {
      expect(shouldLogSerialize({ ...base, bytes: 1024 * 1024 })).toBe(true);
      expect(shouldLogSerialize({ ...base, serializeMs: 5, bytes: 5 * 1024 * 1024 })).toBe(true);
    });

    it('is silent when below BOTH thresholds', () => {
      expect(shouldLogSerialize({ ...base, serializeMs: 249, bytes: 1024 * 1024 - 1 })).toBe(false);
      expect(shouldLogSerialize(base)).toBe(false);
    });

    it('is NaN-safe (a NaN reading never fires)', () => {
      expect(shouldLogSerialize({ ...base, serializeMs: NaN, bytes: NaN })).toBe(false);
    });
  });

  describe('resolveSerializeConfig (env parsing)', () => {
    it('defaults when unset', () => {
      expect(resolveSerializeConfig()).toEqual({
        enabled: true,
        slowMs: 250,
        oversizedBytes: 1024 * 1024,
        floorMs: 50,
        maxPerSec: 50,
      });
    });

    it('honors overrides and rejects footgun values (0/neg thresholds fall back)', () => {
      process.env.TRPC_SERIALIZE_SLOW_MS = '3000';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = '524288';
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '10';
      const cfg = resolveSerializeConfig();
      expect(cfg.slowMs).toBe(3000);
      expect(cfg.oversizedBytes).toBe(524288);
      expect(cfg.floorMs).toBe(10);

      process.env.TRPC_SERIALIZE_SLOW_MS = '0'; // min=1 → reject → default
      expect(resolveSerializeConfig().slowMs).toBe(250);
    });

    it('kill-switch: only explicit falsy tokens disable', () => {
      for (const off of ['false', '0', 'no', 'off']) {
        process.env.TRPC_SERIALIZE_LOG_ENABLED = off;
        expect(resolveSerializeConfig().enabled).toBe(false);
      }
      for (const on of ['true', 'yes', 'on', '']) {
        process.env.TRPC_SERIALIZE_LOG_ENABLED = on;
        expect(resolveSerializeConfig().enabled).toBe(true);
      }
    });
  });

  describe('serializeCtxFromRequest (path correlation from the URL)', () => {
    it('reads the comma-joined batch path from req.query.trpc; GET → query', () => {
      expect(serializeCtxFromRequest({ query: { trpc: 'image.getInfinite' }, method: 'GET' })).toEqual(
        { path: 'image.getInfinite', type: 'query' }
      );
    });

    it('POST maps type to undefined (method-override may make it a query)', () => {
      const ctx = serializeCtxFromRequest({ query: { trpc: 'a,b' }, method: 'POST' });
      expect(ctx.path).toBe('a,b');
      expect(ctx.type).toBeUndefined();
    });

    it('falls back to "unknown" when no path is present', () => {
      expect(serializeCtxFromRequest({ query: {} }).path).toBe('unknown');
    });
  });

  describe('rateGate (per-pod path-diverse cap)', () => {
    it('emits a distinct path once per window, suppresses same-path repeats', () => {
      expect(__rateGateForTest('image.getInfinite', 50, 1000)).toBe(0); // emit
      expect(__rateGateForTest('image.getInfinite', 50, 1100)).toBe(-1); // dup → suppress
      expect(__rateGateForTest('model.getById', 50, 1200)).toBe(0); // distinct → emit
      expect(__rateGateForTest('image.getInfinite', 50, 2001)).toBe(0); // next window → emit
    });
  });

  describe('instrumentSerialize (end-to-end capture)', () => {
    it('does NOT touch the serialize result and is silent below the floor', async () => {
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '999999'; // force sub-floor
      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      const payload = { json: { hello: 'world' }, meta: undefined };
      const out = instrumentSerialize(() => payload);
      expect(out).toBe(payload); // passthrough, unchanged
      await __flushPendingEmitsForTest();
      expect(captured).toHaveLength(0); // below floor → no byte walk, no log
    });

    it('captures path + bytes + serializeMs when oversized (floor/slow tuned to force it)', async () => {
      // floor=0 so any serialize is measured; oversized threshold tiny so a small
      // payload trips the size trigger deterministically without a real 6s stall.
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '0';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = '10';
      process.env.TRPC_SERIALIZE_SLOW_MS = '100000';
      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      const bigPayload = { json: { data: 'x'.repeat(200) }, meta: undefined };
      runWithSerializeCtx({ path: 'image.getInfinite', type: 'query' }, () => {
        instrumentSerialize(() => bigPayload);
      });

      expect(captured).toHaveLength(1);
      const log = captured[0];
      expect(log.path).toBe('image.getInfinite');
      expect(log.procedureType).toBe('query');
      expect(log.bytes).toBe(Buffer.byteLength(JSON.stringify(bigPayload), 'utf8'));
      expect(log.bytes! >= 10).toBe(true);
      expect(log.serializeMs).toBeGreaterThanOrEqual(0);
    });

    it('is disarmed (raw passthrough, no log) when the kill-switch is off', async () => {
      process.env.TRPC_SERIALIZE_LOG_ENABLED = 'false';
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '0';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = '1';
      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      const payload = { json: { a: 1 }, meta: undefined };
      const out = runWithSerializeCtx({ path: 'x' }, () => instrumentSerialize(() => payload));
      expect(out).toBe(payload);
      await __flushPendingEmitsForTest();
      expect(captured).toHaveLength(0);
    });

    it('records "unknown" path when serialized outside a request scope (SSR/SSG)', () => {
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '0';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = '1';
      process.env.TRPC_SERIALIZE_SLOW_MS = '100000';
      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      instrumentSerialize(() => ({ json: { a: 1 }, meta: undefined }));
      expect(captured).toHaveLength(1);
      expect(captured[0].path).toBe('unknown');
    });

    it('propagates a serialize throw unchanged (no log)', () => {
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '0';
      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));
      const boom = new Error('serialize boom');
      expect(() =>
        instrumentSerialize(() => {
          throw boom;
        })
      ).toThrow(boom);
      expect(captured).toHaveLength(0);
    });

    // FIX 1: on the loop-blocking (serializeMs >= slowMs) path, the second full
    // JSON.stringify (safeByteLength) must NOT run per-occurrence — it is ordered
    // AFTER the rate gate, so a slow+wave incident pays it at most maxPerSec/window,
    // not once per serialize on the already-blocked thread.
    it('does NOT run the byte walk per-occurrence when serializeMs >= slowMs under rate-limiting', async () => {
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '0';
      process.env.TRPC_SERIALIZE_SLOW_MS = '250';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = '1'; // ensure size trigger would also fire — isolate the reorder
      process.env.TRPC_SERIALIZE_LOG_MAX_PER_SEC = '50';
      __resetConfigCacheForTests();

      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      // Count byte walks: safeByteLength does JSON.stringify(result), which invokes
      // the result's toJSON exactly once per call.
      let byteWalks = 0;
      const payload = {
        json: { data: 'x'.repeat(64) },
        meta: undefined,
        toJSON() {
          byteWalks++;
          return { data: 'x'.repeat(64) };
        },
      };

      // Deterministic slow serialize: mock performance.now so every call measures a
      // 1000ms (>= slowMs 250) serialize without a real stall.
      let nowVal = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => nowVal);

      const N = 200; // distinct paths so the gate allows up to maxPerSec, then ceilings
      for (let i = 0; i < N; i++) {
        runWithSerializeCtx({ path: `proc.${i}`, type: 'query' }, () =>
          instrumentSerialize(() => {
            nowVal += 1000; // second performance.now() read → delta 1000ms
            return payload;
          })
        );
      }
      await __flushPendingEmitsForTest();

      // Gate caps distinct emits at maxPerSec=50; the byte walk runs ONLY on those,
      // NOT once per serialize (which would be 200). This is the reorder's whole point.
      expect(captured.length).toBe(50);
      expect(byteWalks).toBe(50);
      expect(byteWalks).toBeLessThanOrEqual(50); // <= maxPerSec
      expect(byteWalks).toBeLessThan(N); // decisively not per-occurrence
      // The emitted slow lines still carry the byte size (informational-after-gate).
      expect(captured[0].bytes).toBeGreaterThan(0);
    });

    // FIX 1: the moderate band (floorMs <= serializeMs < slowMs) still uses bytes as
    // the decision input for the oversized-SIZE trigger and logs when >= threshold.
    it('still logs a moderate-duration (below slowMs) but oversized (> 1 MiB) serialize', async () => {
      process.env.TRPC_SERIALIZE_SIZE_CHECK_FLOOR_MS = '50';
      process.env.TRPC_SERIALIZE_SLOW_MS = '250';
      process.env.TRPC_SERIALIZE_OVERSIZED_BYTES = String(1024 * 1024); // 1 MiB
      __resetConfigCacheForTests();

      const captured: SerializeLogPayload[] = [];
      __setEmitSinkForTests((p) => captured.push(p));

      // serializeMs = 100ms → in [floor 50, slow 250): the moderate band.
      let nowVal = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => nowVal);

      const bigPayload = { json: { data: 'y'.repeat(1024 * 1024 + 32) }, meta: undefined }; // > 1 MiB
      runWithSerializeCtx({ path: 'image.getInfinite', type: 'query' }, () =>
        instrumentSerialize(() => {
          nowVal += 100; // moderate duration, below slowMs
          return bigPayload;
        })
      );
      await __flushPendingEmitsForTest();

      expect(captured).toHaveLength(1);
      expect(captured[0].path).toBe('image.getInfinite');
      expect(captured[0].serializeMs).toBe(100);
      expect(captured[0].bytes!).toBeGreaterThanOrEqual(1024 * 1024);
    });
  });
});
