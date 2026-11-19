import { describe, expect, it } from 'vitest';
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

const storedList = (redis: ReturnType<typeof createLuaRedis>): number[] => {
  const raw = redis.hash(KEY)?.[FIELD];
  return raw === undefined ? [] : (unpackFromHarness(raw) as (number | bigint)[]).map(Number);
};

async function runSequence(seed: number, steps: number) {
  const random = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const redis = createLuaRedis(START);
  let now = START;
  // The model's view of the stored list. Starts as history written by the old JS writer.
  let model: number[] = Array.from({ length: Math.floor(random() * 4) }, () =>
    Math.floor(now - random() * 5000)
  ).sort((a, b) => a - b);
  if (model.length) redis.setHash(KEY, { [FIELD]: packedForHarness(model) });
  let decisions = 0;

  for (let step = 0; step < steps; step++) {
    now += pick([0, 0, 1, 250, 1000, 4000]);
    redis.nowMs = now;

    if (random() < 0.15 && model.length) {
      const ts = random() < 0.8 ? pick(model) : now + 1;
      const reply = await redis.eval(RATE_LIMIT_CLAIM_SCRIPT, {
        keys: [KEY],
        arguments: refundScriptArgs(FIELD, ts, TTL_MS),
      });
      const i = model.indexOf(ts);
      expect(reply, `seed ${seed} step ${step}: refund`).toBe(i >= 0 ? 1 : 0);
      if (i >= 0) model.splice(i, 1);
      expect(storedList(redis), `seed ${seed} step ${step}: after refund`).toEqual(model);
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
      expect(storedList(redis), `${at}: stored after refusal`).toEqual(model);
    } else {
      model = [...kept, now];
      expect(storedList(redis), `${at}: stored after admit`).toEqual(model);
      expect(reply.attempts, `${at}: admit reply`).toEqual(local.length ? model : undefined);
      expect(redis.hpttl(KEY, FIELD)).toBe(TTL_MS);
    }
  }
  expect(redis.errors).toEqual([]);
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
