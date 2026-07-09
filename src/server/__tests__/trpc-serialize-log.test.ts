import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __flushPendingEmitsForTest,
  __rateGateForTest,
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
    __setEmitSinkForTests(undefined);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    __setEmitSinkForTests(undefined);
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
  });
});
