import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  reserveSharedWrite,
  type SharedWriteBudgetParams,
  type SharedWriteReservation,
} from '~/server/utils/shared-storage-rate-limit';
import { createLuaRedis, type LuaRedis } from './redis-lua-harness';

/**
 * Differential test: the write-budget Lua (executed via wasmoon) against an independent
 * TypeScript model of the same token buckets, over seeded random sequences of reserve, release
 * and clock advances. Each step compares the caller-visible result AND the stored hash + TTL.
 */

const USER = 9203;
const APP = 'apb_diff_fixture';
const KEY = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-write:v2:${APP}:${USER}`;
const T0 = Date.parse('2032-01-02T03:04:05.000Z') + 613;

// Small, pairwise-distinct, non-round buckets so every bucket binds often.
const P: SharedWriteBudgetParams = {
  burst: { capacity: 3, refillIntervalMs: 7_919 },
  daily: { capacity: 5, refillIntervalMs: 13_337 },
  rejections: { capacity: 2, refillIntervalMs: 21_011 },
};

type Model = { b: number; d: number; r: number } | undefined;
type Bucket = { capacity: number; refillIntervalMs: number };

/** Reference: each field is the instant its bucket is full again; absent = full now. */
function modelStep(
  stored: Model,
  now: number,
  op: { kind: 'reserve' } | { kind: 'release'; rejected: boolean }
): { model: Model; refusedWaitMs?: number } {
  const buckets: Bucket[] = [P.burst, P.daily, P.rejections];
  const full = [stored?.b, stored?.d, stored?.r].map((v) => Math.max(v ?? now, now));
  if (op.kind === 'reserve') {
    const waits = full.map(
      (f, i) => f - now - (buckets[i].capacity - 1) * buckets[i].refillIntervalMs
    );
    const wait = Math.max(0, ...waits);
    if (wait > 0) return { model: stored, refusedWaitMs: wait };
    full[0] += P.burst.refillIntervalMs;
    full[1] += P.daily.refillIntervalMs;
  } else {
    full[0] = Math.max(full[0] - P.burst.refillIntervalMs, now);
    full[1] = Math.max(full[1] - P.daily.refillIntervalMs, now);
    if (op.rejected) {
      const iv = P.rejections.refillIntervalMs;
      full[2] = Math.min(full[2] + iv, now + 2 * P.rejections.capacity * iv);
    }
  }
  if (Math.max(...full) - now <= 0) return { model: undefined };
  return { model: { b: full[0], d: full[1], r: full[2] } };
}

// mulberry32 — a fixed seed reproduces the exact op sequence.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let lua: LuaRedis;

beforeEach(() => {
  resetSharedMocks();
  lua = createLuaRedis(T0);
  redisMock.redis.eval.mockImplementation(
    (script: string, options: { keys: string[]; arguments: string[] }) => lua.eval(script, options)
  );
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

describe('write-budget Lua ≡ TypeScript reference', () => {
  it.each([[0x5eed1], [0xa11ce], [0xc0ffee]])(
    'seed %i: 400 random steps agree on every result, stored hash and TTL',
    async (seed) => {
      const rand = rng(seed);
      let model: Model;
      let modelExpiresAt = 0;
      const open: Array<Extract<SharedWriteReservation, { allowed: true }>> = [];
      let refusals = 0;
      let releases = 0;

      for (let step = 0; step < 400; step++) {
        const roll = rand();
        if (roll < 0.3) {
          // Advance the clock: same-ms, sub-interval, around one interval, or past full refill.
          const scale = [0, 1_000, 9_000, 120_000][Math.floor(rand() * 4)];
          lua.nowMs += Math.floor(rand() * scale);
          continue;
        }
        const now = lua.nowMs;
        if (model && modelExpiresAt <= now) model = undefined;

        if (roll < 0.75 || open.length === 0) {
          const expected = modelStep(model, now, { kind: 'reserve' });
          const actual = await reserveSharedWrite(USER, APP, P);
          if (expected.refusedWaitMs !== undefined) {
            refusals++;
            expect(actual).toEqual({
              allowed: false,
              retryAfterSeconds: Math.max(1, Math.ceil(expected.refusedWaitMs / 1000)),
            });
          } else {
            expect(actual.allowed).toBe(true);
            if (actual.allowed) open.push(actual);
          }
          if (expected.refusedWaitMs === undefined) model = expected.model;
        } else {
          releases++;
          const rejected = rand() < 0.5;
          const r = open.splice(Math.floor(rand() * open.length), 1)[0];
          await r.release({ rejected });
          model = modelStep(model, now, { kind: 'release', rejected }).model;
        }
        if (model) modelExpiresAt = Math.max(model.b, model.d, model.r);

        expect(lua.hash(KEY)).toEqual(
          model ? { b: String(model.b), d: String(model.d), r: String(model.r) } : undefined
        );
        expect(lua.pttl(KEY)).toBe(model ? modelExpiresAt - now : -2);
      }
      // The sequence must actually reach both branches, or agreement proves little.
      expect(refusals).toBeGreaterThan(20);
      expect(releases).toBeGreaterThan(20);
    }
  );
});
