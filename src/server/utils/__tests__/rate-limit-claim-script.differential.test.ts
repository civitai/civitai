import { pack, unpack } from 'msgpackr';
import { createClient, RESP_TYPES } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAttempts } from '~/server/utils/rate-limit-bucket';
import {
  claimScriptArgs,
  parseClaimReply,
  RATE_LIMIT_CLAIM_SCRIPT,
  refundScriptArgs,
} from '~/server/utils/rate-limit-claim-script';
import { bindingRefusal, evaluateRateLimitWindow } from '~/server/utils/rate-limit-window';
import {
  createLuaRedis,
  packedForHarness,
  unpackFromHarness,
} from '~/server/utils/__tests__/redis-lua-harness';

/**
 * The claim script against the JS window rule it must agree with: seeded random sequences of claims
 * (multi-rule, limit-0 gates, local attempts), refunds and clock steps. At every step the script's
 * decision, its reply and the stored list must equal what evaluateRateLimitWindow + bindingRefusal +
 * mergeAttempts decide on the same input.
 */

const KEY = 'packed:trpc:limit:differential';
const FIELD = 'ip:192.0.2.1';
const TTL_MS = 86_400_000;
const START = 1_795_000_000_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a sequence runs: the Lua harness, or a real Redis. */
type Store = {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  seed: (list: number[]) => Promise<void>;
  stored: () => Promise<number[]>;
  /** Remaining ms on the field's TTL. */
  fieldTtl: () => Promise<number>;
  setNow: (ms: number) => void;
  errors: () => unknown[];
};

function harnessStore(): Store {
  const redis = createLuaRedis(START);
  return {
    eval: (script, options) => redis.eval(script, options),
    seed: async (list) => redis.setHash(KEY, { [FIELD]: packedForHarness(list) }),
    stored: async () => {
      const raw = redis.hash(KEY)?.[FIELD];
      return raw === undefined ? [] : (unpackFromHarness(raw) as (number | bigint)[]).map(Number);
    },
    fieldTtl: async () => redis.hpttl(KEY, FIELD),
    setNow: (ms) => {
      redis.nowMs = ms;
    },
    errors: () => redis.errors,
  };
}

async function runSequence(seed: number, steps: number, redis: Store = harnessStore()) {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  let now = START;
  // The model's view of the stored list. Starts as history written by the old JS writer.
  let model: number[] = Array.from({ length: Math.floor(random() * 4) }, () =>
    Math.floor(now - random() * 5000)
  ).sort((a, b) => a - b);
  if (model.length) await redis.seed(model);
  let decisions = 0;

  for (let step = 0; step < steps; step++) {
    now += pick([0, 0, 1, 250, 1000, 4000]);
    redis.setNow(now);

    if (random() < 0.15 && model.length) {
      const ts = random() < 0.8 ? pick(model) : now + 1;
      const reply = await redis.eval(RATE_LIMIT_CLAIM_SCRIPT, {
        keys: [KEY],
        arguments: refundScriptArgs(FIELD, ts, TTL_MS),
      });
      const i = model.indexOf(ts);
      expect(reply, `seed ${seed} step ${step}: refund`).toBe(i >= 0 ? 1 : 0);
      if (i >= 0) model.splice(i, 1);
      expect(await redis.stored(), `seed ${seed} step ${step}: after refund`).toEqual(model);
      continue;
    }

    const rules = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      limit: pick([0, 1, 2, 3, 5, 8]),
      period: pick([1, 2, 5, 10]),
    }));
    const local =
      random() < 0.3
        ? Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
            random() < 0.5 && model.length ? pick(model) : Math.floor(now - random() * 3000)
          )
        : [];
    const keepMs = Math.max(...rules.map((r) => r.period)) * 1000;

    const reply = parseClaimReply(
      await redis.eval(RATE_LIMIT_CLAIM_SCRIPT, {
        keys: [KEY],
        arguments: claimScriptArgs({
          field: FIELD,
          now,
          ttlMs: TTL_MS,
          keepMs,
          local,
          rules: rules.map((r) => ({ limit: r.limit, windowMs: r.period * 1000 })),
        }),
      })
    );

    const kept = mergeAttempts(model, local).filter((x) => x > now - keepMs);
    const refused = !!bindingRefusal(evaluateRateLimitWindow(rules, kept, now));
    const at = `seed ${seed} step ${step}`;
    expect(reply.admitted, `${at}: decision`).toBe(!refused);
    decisions++;
    if (refused) {
      expect(reply.attempts, `${at}: refusal list`).toEqual(kept);
      // A refusal writes nothing.
      expect(await redis.stored(), `${at}: stored after refusal`).toEqual(model);
    } else {
      model = [...kept, now];
      expect(await redis.stored(), `${at}: stored after admit`).toEqual(model);
      expect(reply.attempts, `${at}: admit reply`).toEqual(local.length ? model : undefined);
      expect(TTL_MS - (await redis.fieldTtl())).toBeLessThan(5000);
    }
  }
  expect(redis.errors()).toEqual([]);
  return decisions;
}

describe('rate-limit claim script vs the JS window rule', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'seed %i: 60 steps agree',
    async (seed) => {
      expect(await runSequence(seed, 60)).toBeGreaterThan(30);
    },
    60_000
  );

  it('a limit-0 rule refuses even an empty bucket, and writes nothing', async () => {
    const redis = createLuaRedis(START);
    const reply = parseClaimReply(
      await redis.eval(RATE_LIMIT_CLAIM_SCRIPT, {
        keys: [KEY],
        arguments: claimScriptArgs({
          field: FIELD,
          now: START,
          ttlMs: TTL_MS,
          keepMs: 60_000,
          local: [],
          rules: [{ limit: 0, windowMs: 60_000 }],
        }),
      })
    );
    expect(reply).toEqual({ admitted: false, attempts: [] });
    expect(redis.hash(KEY)).toBeUndefined();
  });
});

// The same sequences once on a real Redis (CI's unit job sets ROSTER_REDIS_URL), so the harness's
// cmsgpack and Lua 5.4 cannot hide a divergence from Redis's own.
const url = process.env.ROSTER_REDIS_URL;
describe.skipIf(!url)('rate-limit claim script vs the JS window rule, on a real Redis', () => {
  const real = createClient({ url });
  const binary = real.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  beforeAll(async () => {
    await real.connect();
  });
  afterAll(async () => {
    await real.del(KEY);
    await real.quit();
  });

  const realStore = (): Store => ({
    eval: (script, options) => real.eval(script, options),
    seed: async (list) => {
      await real.hSet(KEY, FIELD, pack(list));
    },
    stored: async () => {
      const raw = (await binary.hGet(KEY, FIELD)) as Buffer | null;
      return raw == null ? [] : (unpack(raw) as (number | bigint)[]).map(Number);
    },
    fieldTtl: async () =>
      Number(((await real.sendCommand(['HPTTL', KEY, 'FIELDS', '1', FIELD])) as number[])[0]),
    setNow: () => undefined,
    errors: () => [],
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'seed %i: 60 steps agree',
    async (seed) => {
      await real.del(KEY);
      expect(await runSequence(seed, 60, realStore())).toBeGreaterThan(30);
    },
    60_000
  );
});
