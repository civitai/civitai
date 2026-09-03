/**
 * Contract for the external-moderation CACHE PROBE.
 *
 * WHAT IT IS. A dark instrument that answers one question — "if we cached moderation verdicts,
 * how often would we skip the classifier?" — without caching anything. It runs on the generation
 * submission path, so its whole design is negative constraints: it must not change the verdict,
 * must not add latency, must not be able to fail a generation, and must not exist at all until it
 * is switched on.
 *
 * 🔴 WHY THE TESTS LOOK LIKE THIS. A probe that quietly reports zero is indistinguishable from a
 * probe that was never wired up, and both read as "prompts do not repeat" — the reassuring
 * conclusion, which is the one that gets acted on. So every case here is written to fail if the
 * probe is inert, and the fidelity case below (`hashes the PREPARED prompt`) is the one that would
 * survive a green suite if it were dropped: the probe would still record hits and misses, just of
 * the wrong string, and the number it produced would be a plausible underestimate with nothing
 * anywhere to contradict it.
 *
 * These read back the REAL prom-client registry rather than asserting we called our own wrapper —
 * `@civitai/telemetry/client` is not stubbed by src/__tests__/setup.ts.
 */
import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock, overriding the global stub in src/__tests__/setup.ts, so each case can flip the
// probe flag. `vi.hoisted` so it exists before the hoisted `vi.mock` factory references it.
const env = vi.hoisted(() => ({
  EXTERNAL_MODERATION_ENDPOINT: 'https://moderation.example/v1/moderations' as string,
  EXTERNAL_MODERATION_TOKEN: 'tok' as string,
  EXTERNAL_MODERATION_THRESHOLD: 0.5,
  EXTERNAL_MODERATION_TIMEOUT_MS: 5000,
  EXTERNAL_MODERATION_CATEGORIES: undefined as Record<string, string> | undefined,
  EXTERNAL_MODERATION_CACHE_PROBE: true,
}));
vi.mock('~/env/server', () => ({ env }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { serverSchema } from '~/env/server-schema';
import { extModeration } from '~/server/integrations/moderation';

const PROBE = 'civitai_app_external_moderation_cache_probe_total';
const HIST = 'civitai_app_external_moderation_duration_seconds';

type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function probeCount(source: string, window: string, result: string) {
  const vals = await samples(PROBE);
  return (
    vals.find(
      (v) => v.labels.source === source && v.labels.window === window && v.labels.result === result
    )?.value ?? 0
  );
}

/** Every probe series summed — the double-count guard, mirroring the histogram tests. */
async function probeTotal() {
  const vals = await samples(PROBE);
  return vals.reduce((acc, v) => acc + v.value, 0);
}

/**
 * An in-memory stand-in for `SET key value NX EX`, faithful on the ONE property the measurement
 * rests on: the first write for a key wins and returns a reply, every later write returns null.
 * The default mock (`set: ok`) always returns 'OK', i.e. always a MISS — which would let a probe
 * that never reads Redis at all pass a hit/miss test vacuously.
 */
function installRedisFake() {
  const store = new Set<string>();
  redisMock.sysRedis.set.mockImplementation(
    async (key: string, _value: unknown, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && store.has(key)) return null;
      store.add(key);
      return 'OK';
    }
  );
  return store;
}

const okResponse = () => ({
  ok: true,
  json: async () => ({ results: [{ flagged: false, category_scores: {}, categories: {} }] }),
});

function stubFetchOk() {
  const spy = vi.fn(async () => okResponse());
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * The probe is fire-and-forget, so nothing in `moderatePrompt`'s own promise chain waits for it.
 * Poll the registry rather than sleeping a fixed amount — a fixed sleep is the classic flake, and
 * it also silently passes if the probe is slower than the sleep.
 */
async function untilProbeTotal(n: number) {
  await vi.waitFor(async () => expect(await probeTotal()).toBe(n));
}

beforeEach(() => {
  promClient.register.getSingleMetric(PROBE)?.reset();
  promClient.register.getSingleMetric(HIST)?.reset();
  env.EXTERNAL_MODERATION_CACHE_PROBE = true;
  // 🔴 `resetSharedMocks()` in src/__tests__/setup.ts runs once PER FILE, not per test, so
  // `sysRedis.set`'s call history accumulates across every case here. Without this, the
  // `not.toHaveBeenCalled()` assertion in the flag-off case passes only because it happens to run
  // first, and the key/EX assertions below see every earlier case's calls. Found by the key/EX
  // case failing with 30 calls instead of 2.
  redisMock.sysRedis.set.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cache probe — the flag is the arming switch', () => {
  it('records NOTHING and touches Redis not at all when the flag is off', async () => {
    // 🔴 STRUCTURED AS A DIFFERENTIAL, NOT AS A BARE ABSENCE, and that is not stylistic. The first
    // version of this test set the flag off, called once, slept 20 ms and asserted zero — and a
    // mutation run with the flag guard DELETED still passed it. The probe's first invocation has to
    // resolve a lazy `import()`, which takes longer than 20 ms, so the sleep was proving that the
    // probe is slow rather than that it is off. Warming the import inside the test and reusing the
    // same budget makes the absence load-bearing: the flag-on leg demonstrates that observations
    // DO land in this window, so the flag-off leg finding none is evidence.
    installRedisFake();
    stubFetchOk();

    env.EXTERNAL_MODERATION_CACHE_PROBE = true;
    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilProbeTotal(2);
    const redisCallsWhileOn = redisMock.sysRedis.set.mock.calls.length;

    env.EXTERNAL_MODERATION_CACHE_PROBE = false;
    await extModeration.moderatePrompt('an entirely different prompt', 'generate');
    await new Promise((r) => setTimeout(r, 200));

    expect(await probeTotal()).toBe(2);
    expect(redisMock.sysRedis.set.mock.calls.length).toBe(redisCallsWhileOn);
  });

  it('POSITIVE CONTROL: the identical call with the flag ON does record', async () => {
    // Without this pair, the assertion above proves only that the metric name is spelled wrong.
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');

    await untilProbeTotal(2);
    expect(redisMock.sysRedis.set).toHaveBeenCalled();
  });
});

describe('cache probe — hit/miss', () => {
  it('a first-sighting prompt is a MISS in both windows', async () => {
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');

    await untilProbeTotal(2);
    expect(await probeCount('generate', '5m', 'miss')).toBe(1);
    expect(await probeCount('generate', '1h', 'miss')).toBe(1);
    expect(await probeCount('generate', '5m', 'hit')).toBe(0);
  });

  it('the SAME prompt again is a HIT in both windows — and the classifier is still called', async () => {
    installRedisFake();
    const fetchSpy = stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilProbeTotal(2);
    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilProbeTotal(4);

    expect(await probeCount('generate', '5m', 'hit')).toBe(1);
    expect(await probeCount('generate', '1h', 'hit')).toBe(1);
    // 🔴 THE LOAD-BEARING HALF. A hit must not skip the call — this is a probe, not a cache. If
    // this ever reads 1, the probe has silently become a moderation bypass.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT prompt is a miss, not a hit', async () => {
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilProbeTotal(2);
    await extModeration.moderatePrompt('a completely different subject', 'generate');
    await untilProbeTotal(4);

    expect(await probeCount('generate', '5m', 'miss')).toBe(2);
    expect(await probeCount('generate', '5m', 'hit')).toBe(0);
  });
});

describe('cache probe — fidelity to what the classifier actually receives', () => {
  it('hashes the PREPARED prompt, so two raw prompts that normalise to one call are a HIT', async () => {
    // 🔴 THIS IS THE CASE THAT PINS THE CALL SITE. `removeFalsePositiveTriggers` rewrites
    // /\d*girl/ -> 'woman', so these two RAW strings differ but produce a byte-identical request
    // body. A real cache keyed on the request would hit; a probe hashing the raw prompt would
    // record two misses and understate the repeat rate — with every other test here still green.
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('1girl in a field', 'generate');
    await untilProbeTotal(2);
    await extModeration.moderatePrompt('girl in a field', 'generate');
    await untilProbeTotal(4);

    expect(await probeCount('generate', '5m', 'hit')).toBe(1);
    expect(await probeCount('generate', '1h', 'hit')).toBe(1);
  });

  it('CONTROL for the case above: the transform is what collapses them, not the digest being constant', async () => {
    // If `digestPrompt` ignored its argument entirely, the case above would also pass. Two prompts
    // the transform does NOT collapse must stay distinct.
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('1girl in a field', 'generate');
    await untilProbeTotal(2);
    await extModeration.moderatePrompt('1boy in a field', 'generate');
    await untilProbeTotal(4);

    expect(await probeCount('generate', '5m', 'hit')).toBe(0);
    expect(await probeCount('generate', '5m', 'miss')).toBe(2);
  });
});

describe('cache probe — it cannot hurt the generation path', () => {
  it('a Redis failure records outcome=error and the moderation call still succeeds', async () => {
    redisMock.sysRedis.set.mockRejectedValue(new Error('redis is down'));
    stubFetchOk();

    const result = await extModeration.moderatePrompt('a serene landscape', 'generate');

    expect(result).toEqual({ flagged: false, categories: [] });
    await untilProbeTotal(2);
    expect(await probeCount('generate', '5m', 'error')).toBe(1);
    expect(await probeCount('generate', '1h', 'error')).toBe(1);
    // The error must be its OWN series, never folded into miss — a Redis outage counted as misses
    // would read as "prompts stopped repeating".
    expect(await probeCount('generate', '5m', 'miss')).toBe(0);
  });

  it('a Redis call that NEVER settles does not park the moderation call', async () => {
    // The probe is not awaited, so a hung Redis must be invisible to the caller. If someone later
    // adds an `await`, this is the test that catches it — by timing out rather than by asserting a
    // number, which is why it carries its own tight deadline.
    redisMock.sysRedis.set.mockImplementation(() => new Promise(() => undefined));
    stubFetchOk();

    const result = await Promise.race([
      extModeration.moderatePrompt('a serene landscape', 'generate'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('probe blocked the call')), 500)
      ),
    ]);

    expect(result).toEqual({ flagged: false, categories: [] });
  });

  it('records nothing when the integration is not configured — no request, no probe', async () => {
    // The skip path returns before `preparedPrompt` exists. A probe there would count calls that
    // never happened and inflate the denominator of the hit rate.
    //
    // Same differential shape as the flag-off case above, for the same reason: warm the lazy import
    // with a configured call first, so "nothing arrived" cannot be an artefact of not waiting.
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a warmup prompt', 'generate');
    await untilProbeTotal(2);

    const endpoint = env.EXTERNAL_MODERATION_ENDPOINT;
    env.EXTERNAL_MODERATION_ENDPOINT = '';
    try {
      await extModeration.moderatePrompt('a serene landscape', 'generate');
      await new Promise((r) => setTimeout(r, 200));
      expect(await probeTotal()).toBe(2);
    } finally {
      env.EXTERNAL_MODERATION_ENDPOINT = endpoint;
    }
  });
});

describe('cache probe — label bounds', () => {
  it('clamps an out-of-set source to `other`, so no caller can mint a label value', async () => {
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'not-a-real-source' as never);

    await untilProbeTotal(2);
    expect(await probeCount('other', '5m', 'miss')).toBe(1);
    expect(await probeCount('not-a-real-source', '5m', 'miss')).toBe(0);
  });

  it('emits exactly two observations per call — one per window, never more', async () => {
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilProbeTotal(2);

    const windows = new Set((await samples(PROBE)).map((v) => String(v.labels.window)));
    expect([...windows].sort()).toEqual(['1h', '5m']);
  });

  it('writes each window under its own key with NX and the matching EX', async () => {
    installRedisFake();
    stubFetchOk();

    await extModeration.moderatePrompt('a serene landscape', 'generate');
    await untilProbeTotal(2);

    const calls = redisMock.sysRedis.set.mock.calls as [
      string,
      unknown,
      { NX: boolean; EX: number }
    ][];
    expect(calls).toHaveLength(2);
    // NX is what makes the measurement atomic: GET-then-SET would race two concurrent submissions
    // of one prompt into two misses and undercount exactly the population being measured.
    expect(calls.every(([, , opts]) => opts.NX === true)).toBe(true);
    expect(calls.map(([, , opts]) => opts.EX).sort((a, b) => a - b)).toEqual([300, 3600]);
    // Distinct keys, or the two windows would contend on one slot and the 5m series would be a
    // copy of the 1h one.
    expect(new Set(calls.map(([key]) => key)).size).toBe(2);
    expect(calls.every(([key]) => key.startsWith('generation:moderation-cache-probe:'))).toBe(true);
  });
});

describe('cache probe — env schema', () => {
  it('defaults to OFF, so the code ships inert and the arming instant is readable', () => {
    const parsed = serverSchema.safeParse({});
    // The schema has many required keys; only this field's default is under test.
    const value = parsed.success
      ? parsed.data.EXTERNAL_MODERATION_CACHE_PROBE
      : serverSchema.shape.EXTERNAL_MODERATION_CACHE_PROBE.parse(undefined);
    expect(value).toBe(false);
  });
});
