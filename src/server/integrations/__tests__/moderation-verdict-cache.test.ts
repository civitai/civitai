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
  EXTERNAL_MODERATION_CACHE_NAMESPACE: 'prod' as string,
}));
vi.mock('~/env/server', () => ({ env }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { serverSchema } from '~/env/server-schema';
import { extModeration } from '~/server/integrations/moderation';
import {
  buildVerdictKey,
  CACHE_NAMESPACES,
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
  env.EXTERNAL_MODERATION_CACHE_NAMESPACE = 'prod';
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

describe('arming needs BOTH an allowlisted namespace and a positive TTL', () => {
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
    // 0.4 floors to 0 -> off. The schema degrades a non-integer to 0 via `.catch(0)`; this is
    // defence in depth, not a restatement of a rejection the schema no longer performs.
    expect(moderationCacheEnabled()).toBe(false);
  });

  it('the env schema accepts an integer TTL and DEGRADES anything else to 0 (OFF), never throwing', () => {
    const parsed = serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(undefined);
    expect(parsed.success && parsed.data).toBe(0);
    expect(serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(300).success).toBe(
      true
    );
    // 🔴 `.catch(0)`, so an operator typo degrades to OFF instead of throwing. An earlier revision
    // pinned `success === false` — i.e. it asserted the fleet-CrashLooping behaviour AS INTENDED,
    // because env.ts throws on any invalid field and env parses only at container start.
    const typo = serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse('off');
    expect(typo.success && typo.data).toBe(0);
    const over = serverSchema.shape.EXTERNAL_MODERATION_CACHE_TTL_SECONDS.safeParse(7200);
    expect(over.success && over.data).toBe(0);
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

  it('🔴 a non-string CATEGORY element is an ERROR and re-calls (the other half of the strict guard)', async () => {
    // This guard had NO test: deleting the `c.some(x => typeof x !== 'string')` clause left the
    // suite fully green, because every other malformed case attacks `f` or the JSON parse. A stored
    // `{"f":false,"c":[{"x":1}]}` would deserialize to categories:[{x:1}], and those values flow on
    // to PromptTrigger `message`/`matchedWord` and into reportProhibitedRequest.
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();
    await extModeration.moderatePrompt('nonstring cats', 'generate');
    await untilStored(store, 1);
    store.set([...store.keys()][0], '{"f":false,"c":[1]}');

    await extModeration.moderatePrompt('nonstring cats', 'generate');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await cacheCount('error')).toBe(1);
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

  it('🔴 the awaited read is DEADLINE-WRAPPED — a hung sysRedis cannot park the submit path', async () => {
    // 🔴 THE DEFECT THIS PINS IS A HANG, NOT A REJECTION, and the try/catch cannot see one. The sys
    // client has no socketTimeout, so on a silent half-open a written command parks in node-redis's
    // reply queue until OS TCP keepalive errors the socket — ~11 MINUTES on Linux defaults — on
    // every authenticated request. This read is awaited on the generation submission path.
    //
    // Driven through the mock's `withSysReadDeadline` SEAM, whose default is the REAL wrapper. A
    // never-settling `get` is only survivable if the call is routed through the deadline; an
    // unwrapped `await sysRedis.get(...)` hangs this test instead of failing it.
    installRedisStore();
    redisMock.sysRedis.get.mockImplementation(() => new Promise(() => {})); // never settles
    // 🔴 `Once`, NOT `mockImplementation`. `vi.restoreAllMocks()` in afterEach does NOT reset a
    // SHARED-module mock's implementation, so a persistent override here leaks into every later
    // case in this file: the first draft of this test made `withSysReadDeadline` throw forever,
    // and the threshold-invalidation test three describes down failed with 2 fetch calls instead
    // of 1. Same per-file persistence trap the beforeEach already clears `get`/`set` for.
    redisMock.withSysReadDeadline.mockImplementationOnce(async () => {
      throw new Error('sys read deadline exceeded');
    });
    const fetchSpy = stubFetchOk();

    const result = await extModeration.moderatePrompt('hung redis', 'generate');

    expect(fetchSpy).toHaveBeenCalledTimes(1); // fell through to the classifier
    expect(result).toEqual({ flagged: false, categories: [] });
    expect(await cacheCount('error')).toBe(1);
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

describe('the deployment namespace is required to arm', () => {
  it('🔴 an unknown namespace disables the cache — an unrecognised deployment must never share a keyspace', async () => {
    const store = installRedisStore();
    const fetchSpy = stubFetchOk();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Differential: the armed leg proves a read lands in this window.
    env.EXTERNAL_MODERATION_CACHE_NAMESPACE = 'prod';
    await extModeration.moderatePrompt('ns armed', 'generate');
    await untilStored(store, 1);
    expect(redisMock.sysRedis.get).toHaveBeenCalled();

    redisMock.sysRedis.get.mockClear();
    env.EXTERNAL_MODERATION_CACHE_NAMESPACE = 'preview';
    await extModeration.moderatePrompt('ns armed', 'generate');

    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
    expect(moderationCacheEnabled()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    // 🔴 THE WRITE SIDE TOO — AND IT CANNOT BE ASSERTED IMMEDIATELY. Asserting only the READ left
    // the write-side arming guard unpinned and it SURVIVED mutation on a green 28/28 suite: a
    // rejected namespace stopped being inert and wrote `…:null:<policy>:<digest>` into one shared
    // un-namespaced keyspace.
    //
    // 🔴 The obvious fix is ALSO vacuous, and was tried first: `expect(sysRedis.set).not
    // .toHaveBeenCalled()` right here passes whether or not the guard exists, because
    // `writeCachedVerdict` is fire-and-forget behind a lazy `import()` — the write has not happened
    // YET either way. An absence you did not wait for is not an absence.
    //
    // So ORDER it. Issue a third call that IS armed, wait for ITS write to land, and only then
    // assert the keyspace. The rejected call was issued first through the same import-then-set
    // path, so if it were going to write it would have written by now.
    env.EXTERNAL_MODERATION_CACHE_NAMESPACE = 'prod';
    await extModeration.moderatePrompt('ns armed again', 'generate');
    await untilStored(store, 2);

    expect(store.size).toBe(2); // the two ARMED entries only — the rejected call wrote nothing
    for (const key of store.keys()) expect(key).toContain(':prod:');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('🔴 every on/off spelling an operator might reach for is OFF, not a namespace', () => {
    // The charset-plus-denylist approach the probe's audit rejected accepted all of these.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const word of ['y', 'n', 'no', 'off', 'false', 'none', 'null', 'disable', '0', '2']) {
      env.EXTERNAL_MODERATION_CACHE_NAMESPACE = word;
      expect(moderationCacheEnabled()).toBe(false);
    }
  });

  it('an empty namespace is the deliberately-unarmed case and logs nothing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    env.EXTERNAL_MODERATION_CACHE_NAMESPACE = '';
    expect(moderationCacheEnabled()).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('the allowlist is asserted as a LEDGER — it fails when the set grows OR shrinks', () => {
    expect([...CACHE_NAMESPACES]).toEqual(['prod']);
  });
});

describe('key shape', () => {
  it('🔴 separates two DEPLOYMENTS for the same prompt and policy', () => {
    // 🔴 THE ONLY PLACE THIS IS REACHABLE. `CACHE_NAMESPACES` has one member, so no test driven
    // through the public surface can distinguish a key that carries the namespace from one that
    // hardcodes it — the same blind spot the probe documented when its allowlist narrowed to one.
    // Passing the namespace as an ARGUMENT is what makes the segment testable at all.
    const prod = buildVerdictKey('generation:moderation-verdict', 'prod', 'p', 'd');
    const preview = buildVerdictKey('generation:moderation-verdict', 'preview', 'p', 'd');
    expect(prod).not.toBe(preview);
  });

  it('separates two policies for the same prompt', () => {
    const a = buildVerdictKey('generation:moderation-verdict', 'prod', 'policyA', 'deadbeef');
    const b = buildVerdictKey('generation:moderation-verdict', 'prod', 'policyB', 'deadbeef');
    expect(a).toBe('generation:moderation-verdict:prod:policyA:deadbeef');
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
    expect(key).toMatch(/^generation:moderation-verdict:prod:[0-9a-f]{16}:[0-9a-f]{32}$/);
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
