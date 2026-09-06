/**
 * Contract for the external-moderation VERDICT CACHE.
 *
 * WHAT IT IS. A read-through cache that lets an identical prompt skip the classifier call entirely.
 * Unlike the dark probe it replaces, this one CHANGES BEHAVIOUR: on a hit no request is issued and
 * the stored verdict is returned. It sits on a moderation gate, so most of these cases are negative
 * constraints — what it must never do — rather than happy-path coverage.
 *
 * 🔴 WHY THE TESTS LOOK LIKE THIS. The dangerous failure of a moderation cache is not "it misses
 * too often" (that costs latency, which we already pay). It is serving a PERMISSIVE verdict that
 * was never computed: a malformed entry read as `flagged:false`, a failure cached as a pass, or a
 * verdict computed under a policy that no longer exists. Every case below is written so that the
 * lenient direction fails, and the absence assertions are structured as DIFFERENTIALS — the probe's
 * own test suite learned that the hard way, when a bare "asserted zero" passed with the arming
 * guard deleted because the first lazy `import()` simply hadn't resolved inside the sleep.
 *
 * These read back the REAL prom-client registry rather than asserting we called our own wrapper.
 */
import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock, overriding the global stub in src/__tests__/setup.ts, so each case can flip the
// TTL. `vi.hoisted` so it exists before the hoisted `vi.mock` factory references it.
const env = vi.hoisted(() => ({
  EXTERNAL_MODERATION_ENDPOINT: 'https://moderation.example/v1/moderations' as string,
  EXTERNAL_MODERATION_TOKEN: 'tok' as string,
  EXTERNAL_MODERATION_THRESHOLD: 0.5,
  EXTERNAL_MODERATION_TIMEOUT_MS: 5000,
  EXTERNAL_MODERATION_CATEGORIES: undefined as Record<string, string> | undefined,
  EXTERNAL_MODERATION_CACHE_PROBE: '' as string,
  EXTERNAL_MODERATION_CACHE_TTL_SECONDS: 300,
}));
vi.mock('~/env/server', () => ({ env }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { serverSchema } from '~/env/server-schema';
import { extModeration } from '~/server/integrations/moderation';
import {
  buildVerdictKey,
  moderationCacheEnabled,
  policyDigest,
} from '~/server/integrations/moderation-verdict-cache';

const CACHE = 'civitai_app_external_moderation_cache_total';
const HIST = 'civitai_app_external_moderation_duration_seconds';

type Sample = { labels: Record<string, string | number>; value: number };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function cacheCount(result: string, source = 'generate') {
  const vals = await samples(CACHE);
  return vals.find((v) => v.labels.source === source && v.labels.result === result)?.value ?? 0;
}

/** Every histogram `_count` summed — used to prove a cache hit records NO latency sample. */
async function histCount() {
  return (await samples(HIST))
    .filter((v) =>
      String((v as unknown as { metricName?: string }).metricName ?? '').endsWith('_count')
    )
    .reduce((acc, v) => acc + v.value, 0);
}

/**
 * A real in-memory key/value store behind `sysRedis.get`/`set`.
 *
 * 🔴 THE DEFAULT MOCK CANNOT TEST THIS. `get` defaults to null (always a miss) and `set` to 'OK',
 * so a cache that never actually reads Redis would pass every miss case vacuously and could never
 * produce a hit at all. The store is what makes a hit reachable, which is the point.
 */
function installRedisStore() {
  const store = new Map<string, string>();
  redisMock.sysRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.sysRedis.set.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  return store;
}

const okResponse = (flagged = false, categories: Record<string, boolean> = {}) => ({
  ok: true,
  json: async () => ({
    results: [{ flagged, category_scores: {}, categories }],
  }),
});

function stubFetchOk(flagged = false) {
  const spy = vi.fn(async () => okResponse(flagged));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The store write is fire-and-forget; poll rather than sleep. A fixed sleep is the classic flake. */
async function untilStored(store: Map<string, string>, n: number) {
  await vi.waitFor(() => expect(store.size).toBe(n));
}

beforeEach(() => {
  promClient.register.getSingleMetric(CACHE)?.reset();
  promClient.register.getSingleMetric(HIST)?.reset();
  env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 300;
  env.EXTERNAL_MODERATION_THRESHOLD = 0.5;
  env.EXTERNAL_MODERATION_CATEGORIES = undefined;
  // `resetSharedMocks()` runs once PER FILE, not per test, so call history accumulates across
  // cases — the same trap documented in the probe's suite.
  redisMock.sysRedis.get.mockClear();
  redisMock.sysRedis.set.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the TTL is the arming switch', () => {
  it('is OFF with no TTL: Redis untouched, no series, classifier still called', async () => {
    // Structured as a DIFFERENTIAL. The armed leg proves a read DOES land in this window, so the
    // unarmed leg finding none is evidence rather than a slow lazy import.
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 300;
    await extModeration.moderatePrompt('armed leg', 'generate');
    await untilStored(store, 1);
    expect(redisMock.sysRedis.get).toHaveBeenCalled();

    redisMock.sysRedis.get.mockClear();
    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 0;
    await extModeration.moderatePrompt('unarmed leg', 'generate');

    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
    expect(store.size).toBe(1); // nothing new written
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the classifier is called either way
    expect(moderationCacheEnabled()).toBe(false);
  });

  it('treats a negative or fractional TTL as OFF rather than coercing it', async () => {
    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = -1;
    expect(moderationCacheEnabled()).toBe(false);
    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 0;
    expect(moderationCacheEnabled()).toBe(false);
    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 0.4;
    // 0.4 floors to 0 -> off. The env schema rejects non-integers anyway; this is defence in depth.
    expect(moderationCacheEnabled()).toBe(false);
  });

  it('the env schema accepts an integer TTL, rejects a non-number, and defaults to 0 (OFF)', () => {
    const parsed = serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(undefined);
    expect(parsed.success && parsed.data).toBe(0);
    expect(serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(300).success).toBe(
      true
    );
    expect(serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse('nope').success).toBe(
      false
    );
    // Capped: a cached verdict is a stale verdict, and the TTL is the only bound on a classifier
    // whose model can move behind a stable name.
    expect(serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(3601).success).toBe(
      false
    );
  });
});

describe('a hit skips the classifier', () => {
  it('second identical prompt returns the stored verdict and issues NO request', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    const first = await extModeration.moderatePrompt('same prompt', 'generate');
    await untilStored(store, 1);
    const second = await extModeration.moderatePrompt('same prompt', 'generate');

    expect(fetchSpy).toHaveBeenCalledTimes(1); // the whole point
    expect(second).toEqual(first);
    expect(await cacheCount('miss')).toBe(1);
    expect(await cacheCount('hit')).toBe(1);
  });

  it('🔴 a hit records NO latency sample — the histogram keeps meaning "cost of a real call"', async () => {
    const store = installRedisStore();
    stubFetchOk();

    await extModeration.moderatePrompt('histogram prompt', 'generate');
    await untilStored(store, 1);
    const afterMiss = await histCount();
    await extModeration.moderatePrompt('histogram prompt', 'generate');
    const afterHit = await histCount();

    // If a hit were observed, the count would rise and the p50 would collapse toward zero —
    // destroying the one instrument that measures what a classifier call costs.
    expect(afterMiss).toBe(1);
    expect(afterHit).toBe(1);
  });

  it('🔴 a FLAGGED verdict round-trips as flagged — a cached block stays blocked', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk(true);

    const first = await extModeration.moderatePrompt('bad prompt', 'generate');
    await untilStored(store, 1);
    const second = await extModeration.moderatePrompt('bad prompt', 'generate');

    expect(first.flagged).toBe(true);
    // The lenient direction is the dangerous one: a serialization that lost `true` would let a
    // previously-blocked prompt through for the whole TTL, and nothing else would notice.
    expect(second.flagged).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT prompt is a miss and does call the classifier', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    await extModeration.moderatePrompt('prompt one', 'generate');
    await untilStored(store, 1);
    await extModeration.moderatePrompt('prompt two', 'generate');
    await untilStored(store, 2);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await cacheCount('hit')).toBe(0);
  });

  it('keys on the PREPARED prompt, so a false-positive rewrite collapses to one call', async () => {
    // `removeFalsePositiveTriggers` maps 'girl' -> 'woman', so these two produce an IDENTICAL
    // classifier request. Keying the raw prompt would issue two calls and silently halve the
    // benefit, with a plausible-looking hit rate and nothing to contradict it.
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    await extModeration.moderatePrompt('a girl in a field', 'generate');
    await untilStored(store, 1);
    await extModeration.moderatePrompt('a woman in a field', 'generate');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await cacheCount('hit')).toBe(1);
  });
});

describe('what must NEVER be cached', () => {
  it('🔴 a failed call is not stored — a failure must cost a retry every time', async () => {
    const store = installRedisStore();
    const failing = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'down',
    }));
    vi.stubGlobal('fetch', failing);

    await expect(extModeration.moderatePrompt('failing prompt', 'generate')).rejects.toThrow();
    // Caching a failure would convert one transient gateway error into TTL-long silent
    // under-moderation of this exact prompt, because the caller is fail-soft on error.
    expect(store.size).toBe(0);

    // And the next attempt really does call again rather than answering from a poisoned entry.
    const ok = stubFetchOk();
    await extModeration.moderatePrompt('failing prompt', 'generate');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('🔴 a malformed stored value is an ERROR and re-calls — never a permissive verdict', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    await extModeration.moderatePrompt('poisoned', 'generate');
    await untilStored(store, 1);
    const key = [...store.keys()][0];
    store.set(key, '{"f":0,"c":[]}'); // `0`, not `false` — truthiness would read this as "not flagged"

    const result = await extModeration.moderatePrompt('poisoned', 'generate');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // re-called, not trusted
    expect(await cacheCount('error')).toBe(1);
    expect(result.flagged).toBe(false); // from the live call, not from the malformed entry
  });

  it('unparseable JSON is an error and re-calls', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();
    await extModeration.moderatePrompt('badjson', 'generate');
    await untilStored(store, 1);
    store.set([...store.keys()][0], 'not json at all');

    await extModeration.moderatePrompt('badjson', 'generate');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await cacheCount('error')).toBe(1);
  });

  it('🔴 a Redis read failure falls through to the classifier, never to a weaker verdict', async () => {
    installRedisStore();
    redisMock.sysRedis.get.mockRejectedValue(new Error('redis is down'));
    const fetchSpy = stubFetchOk();

    const result = await extModeration.moderatePrompt('redis down', 'generate');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ flagged: false, categories: [] });
    expect(await cacheCount('error')).toBe(1);
    expect(await cacheCount('hit')).toBe(0);
  });

  it('a Redis WRITE failure does not fail the request', async () => {
    installRedisStore();
    redisMock.sysRedis.set.mockRejectedValue(new Error('redis is down'));
    stubFetchOk();
    await expect(extModeration.moderatePrompt('write fails', 'generate')).resolves.toEqual({
      flagged: false,
      categories: [],
    });
  });
});

describe('the policy digest is the staleness answer', () => {
  const D = () => policyDigest('omni-moderation-latest', 0.5, undefined);

  it('changes when the THRESHOLD changes', () => {
    expect(policyDigest('omni-moderation-latest', 0.6, undefined)).not.toBe(D());
  });

  it('changes when the MODEL changes', () => {
    expect(policyDigest('text-moderation-007', 0.5, undefined)).not.toBe(D());
  });

  it('changes when the CATEGORY MAP changes', () => {
    expect(policyDigest('omni-moderation-latest', 0.5, { violence: 'v' })).not.toBe(D());
    expect(policyDigest('omni-moderation-latest', 0.5, { violence: 'v' })).not.toBe(
      policyDigest('omni-moderation-latest', 0.5, { violence: 'w' })
    );
  });

  it('is STABLE under a category key reorder — a reshuffle must not flush the cache', () => {
    expect(policyDigest('m', 0.5, { a: '1', b: '2' })).toBe(
      policyDigest('m', 0.5, { b: '2', a: '1' })
    );
  });

  it('🔴 a threshold change makes previously-cached verdicts unreachable, with no flush step', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();

    await extModeration.moderatePrompt('policy prompt', 'generate');
    await untilStored(store, 1);
    await extModeration.moderatePrompt('policy prompt', 'generate');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // hit under the original policy

    env.EXTERNAL_MODERATION_THRESHOLD = 0.9; // policy changed
    await extModeration.moderatePrompt('policy prompt', 'generate');

    // The old entry is still IN Redis — it simply cannot be addressed any more, and ages out on its
    // own EX. That is the whole design: invalidation with nothing for an operator to remember.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The store write is fire-and-forget, so POLL for it. Asserting `store.size` straight after the
    // call read 1 and failed — the classifier had already been re-called (which is the behaviour
    // under test) but the new entry had not landed yet.
    await untilStored(store, 2);
    expect(store.size).toBe(2);
  });
});

describe('key shape', () => {
  it('separates two policies for the same prompt', () => {
    const a = buildVerdictKey('generation:moderation-verdict', 'policyA', 'deadbeef');
    const b = buildVerdictKey('generation:moderation-verdict', 'policyB', 'deadbeef');
    expect(a).toBe('generation:moderation-verdict:policyA:deadbeef');
    expect(a).not.toBe(b);
  });

  it('🔴 the prompt itself never reaches Redis — only digests', async () => {
    const store = installRedisStore();
    stubFetchOk();
    const secret = 'a very distinctive prompt string';
    await extModeration.moderatePrompt(secret, 'generate');
    await untilStored(store, 1);

    const key = [...store.keys()][0];
    expect(key).not.toContain(secret);
    expect(key).not.toContain('distinctive');
    expect(key).toMatch(/^generation:moderation-verdict:[0-9a-f]{16}:[0-9a-f]{32}$/);
    // The stored VALUE carries the verdict only, never the prompt.
    expect(store.get(key)).not.toContain('distinctive');
  });

  it('stores with the configured EX', async () => {
    const store = installRedisStore();
    stubFetchOk();
    env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS = 300;
    await extModeration.moderatePrompt('ttl prompt', 'generate');
    await untilStored(store, 1);
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('generation:moderation-verdict:'),
      expect.any(String),
      { EX: 300 }
    );
  });
});
