/**
 * Instrumentation contract for `extModeration.moderatePrompt`.
 *
 * WHY these exist: the call is an outbound HTTP request to a third-party classifier, it runs inline
 * and serially on the generation submission path, it is bounded by a 5 s abort deadline, and it is
 * FAIL-SOFT — the caller catches, logs one Axiom line and proceeds with `flagged:false`. That last
 * property is what made it invisible: a fully-down moderation gateway and a healthy one produce the
 * same user-visible behaviour and the same (absent) metrics, so "how long does this take", "how
 * often does it fail" and "how often does it hit its cap" had no answers at all.
 *
 * These tests read back the REAL prom-client registry (`@civitai/telemetry/client` is not stubbed by
 * src/__tests__/setup.ts, which replaces only `~/server/prom/client`), so they assert what is
 * actually recorded on the registry /api/metrics scrapes rather than that we called our own wrapper.
 *
 * 🔴 THE ASSERTION THAT MATTERS MOST IS THE TOTAL COUNT. Every failure path here is reachable two
 * ways (a `finally` plus a `catch`, or an observation in both the wrapper and the callee), and a
 * double-counted hot-path histogram is worse than no histogram — it inflates the very rate the
 * metric exists to produce while looking perfectly healthy. So each case asserts the count across
 * EVERY series, not only the one it expects to move.
 */
import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock so each test can set the timeout / endpoint. `vi.hoisted` so it exists before
// the hoisted `vi.mock` factory references it. Overrides the global stub in src/__tests__/setup.ts.
const env = vi.hoisted(() => ({
  EXTERNAL_MODERATION_ENDPOINT: 'https://moderation.example/v1/moderations' as string,
  EXTERNAL_MODERATION_TOKEN: 'tok' as string,
  EXTERNAL_MODERATION_THRESHOLD: 0.5,
  EXTERNAL_MODERATION_TIMEOUT_MS: 5000,
  EXTERNAL_MODERATION_CATEGORIES: undefined as Record<string, string> | undefined,
}));
vi.mock('~/env/server', () => ({ env }));

import { extModeration } from '~/server/integrations/moderation';

const HIST = 'civitai_app_external_moderation_duration_seconds';
const SKIPPED = 'civitai_app_external_moderation_skipped_total';

type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function histCount(source: string, outcome: string) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_count` &&
        v.labels.source === source &&
        v.labels.outcome === outcome
    )?.value ?? 0
  );
}

/** Observations across EVERY (source, outcome) series — the double-count guard. */
async function histTotalCount() {
  const vals = await samples(HIST);
  return vals.filter((v) => v.metricName === `${HIST}_count`).reduce((acc, v) => acc + v.value, 0);
}

async function histSum(source: string, outcome: string) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_sum` && v.labels.source === source && v.labels.outcome === outcome
    )?.value ?? 0
  );
}

/** Cumulative bucket value at boundary `le` (prom histogram buckets are cumulative). */
async function histBucket(source: string, outcome: string, le: number) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_bucket` &&
        v.labels.source === source &&
        v.labels.outcome === outcome &&
        Number(v.labels.le) === le
    )?.value ?? 0
  );
}

async function skippedCount(source: string) {
  const vals = await samples(SKIPPED);
  return vals.find((v) => v.labels.source === source)?.value ?? 0;
}

const okResponse = (flagged: boolean) => ({
  ok: true,
  json: async () => ({
    results: [{ flagged, category_scores: {}, categories: {} }],
  }),
});

beforeEach(() => {
  promClient.register.getSingleMetric(HIST)?.reset();
  promClient.register.getSingleMetric(SKIPPED)?.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.EXTERNAL_MODERATION_ENDPOINT = 'https://moderation.example/v1/moderations';
  env.EXTERNAL_MODERATION_TOKEN = 'tok';
  env.EXTERNAL_MODERATION_TIMEOUT_MS = 5000;
  env.EXTERNAL_MODERATION_CATEGORIES = undefined;
});

describe('moderatePrompt instrumentation — success path', () => {
  it('records exactly one observation with outcome=ok on the declared source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(false))
    );

    await extModeration.moderatePrompt('a serene landscape', 'generate');

    expect(await histCount('generate', 'ok')).toBe(1);
    expect(await histTotalCount()).toBe(1);
  });

  it('records the WALL-CLOCK duration, not a placeholder', async () => {
    // A classifier that takes ~30ms. Asserting a floor (rather than ">= 0") is what separates a
    // real timer from an implementation that records a constant: a hardcoded 0 passes ">= 0".
    vi.stubGlobal('fetch', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return okResponse(false);
    });

    await extModeration.moderatePrompt('a cat', 'generate');

    const seconds = await histSum('generate', 'ok');
    expect(seconds).toBeGreaterThanOrEqual(0.02);
    // Sanity ceiling: this catches a ms/seconds unit inversion — recording 30 (ms) instead of
    // 0.03 (s) sails past the floor above. Set well clear of both sides (a 30ms sleep cannot
    // stretch to 5s even on a loaded runner; a ms-valued observation is >= 30) so the guard is
    // decided by the unit, not by scheduling noise.
    expect(seconds).toBeLessThan(5);
  });

  it('defaults an undeclared caller to source=other rather than to generate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(false))
    );

    await extModeration.moderatePrompt('a cat');

    expect(await histCount('other', 'ok')).toBe(1);
    expect(await histCount('generate', 'ok')).toBe(0);
  });

  it('clamps a source outside the vocabulary to other', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(false))
    );

    await extModeration.moderatePrompt('a cat', 'generateFromGraph' as never);

    expect(await histCount('other', 'ok')).toBe(1);
    expect(await histCount('generateFromGraph', 'ok')).toBe(0);
  });

  it('does not change the verdict it returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(true))
    );

    const r = await extModeration.moderatePrompt('x', 'generate');

    expect(r.flagged).toBe(true);
  });
});

describe('moderatePrompt instrumentation — failure paths', () => {
  it('records outcome=error WITH a duration when the classifier returns a non-2xx, and still throws', async () => {
    vi.stubGlobal('fetch', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'upstream connect error',
      };
    });

    await expect(extModeration.moderatePrompt('x', 'generate')).rejects.toThrow(/503/);

    expect(await histCount('generate', 'error')).toBe(1);
    // A failed call still consumed wall time on the generation path — the whole point of labelling
    // by outcome rather than dropping failures is that their latency is not free.
    expect(await histSum('generate', 'error')).toBeGreaterThanOrEqual(0.02);
    expect(await histCount('generate', 'timeout')).toBe(0);
    expect(await histTotalCount()).toBe(1);
  });

  it('records outcome=timeout — NOT error — when the abort deadline fires', async () => {
    env.EXTERNAL_MODERATION_TIMEOUT_MS = 25;
    // A gateway that never answers: only the abort resolves this.
    vi.stubGlobal('fetch', (_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject((opts.signal as AbortSignal).reason ?? new Error('aborted'))
        );
      });
    });

    await expect(extModeration.moderatePrompt('a hanging prompt', 'generate')).rejects.toBeTruthy();

    expect(await histCount('generate', 'timeout')).toBe(1);
    expect(await histCount('generate', 'error')).toBe(0);
    expect(await histTotalCount()).toBe(1);
  });

  it('classifies a network-level fetch rejection as error, not timeout', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(extModeration.moderatePrompt('x', 'generate')).rejects.toThrow(/fetch failed/);

    expect(await histCount('generate', 'error')).toBe(1);
    expect(await histCount('generate', 'timeout')).toBe(0);
  });

  it('records exactly one observation when the caller wraps the call in its own fail-soft catch', async () => {
    // The real shape at the call site (promptAuditing.auditPromptServer): the rejection is caught
    // and swallowed. A `finally`-based recorder alongside a `catch`-based one would show 2 here
    // while every other assertion in this file still passed.
    vi.stubGlobal('fetch', async () => {
      throw new Error('External moderation failed: 500 Internal Server Error');
    });

    const result = await extModeration
      .moderatePrompt('x', 'generate')
      .catch(() => ({ flagged: false, categories: [] as string[] }));

    expect(result).toEqual({ flagged: false, categories: [] });
    expect(await histTotalCount()).toBe(1);
  });

  it('records one observation per call across a mixed sequence — never more', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(false))
    );
    await extModeration.moderatePrompt('a', 'generate');
    await extModeration.moderatePrompt('b', 'preset');

    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    await extModeration.moderatePrompt('c', 'generate').catch(() => null);

    expect(await histTotalCount()).toBe(3);
    expect(await histCount('generate', 'ok')).toBe(1);
    expect(await histCount('preset', 'ok')).toBe(1);
    expect(await histCount('generate', 'error')).toBe(1);
  });
});

describe('a FIRED deadline is observed ABOVE the bucket boundary that equals the deadline', () => {
  /**
   * 🔴 THE ONE CLAIM THE BUCKET SET IS DESIGNED AROUND, DRIVEN END TO END.
   *
   * `external-moderation.metrics.test.ts` pins that the boundaries `5` and `7.5` both exist and
   * that a 4.9 s and a 5.02 s observation land on opposite sides of `le=5`. But it hand-feeds those
   * two numbers to `observeExternalModeration`, so it never runs the code that PRODUCES the number
   * and cannot see a regression that makes a real fired deadline observe at or below 5 s. Every
   * operator-facing sentence about this family — the help text's "those observations land just above
   * the cap (le=7.5 at the 5s default), never in le=5" — is a claim about the produced value, not
   * about the bucket list.
   *
   * WHY IT HOLDS TODAY, mechanically: `start` is taken in `moderatePrompt` BEFORE `withSpan`, and
   * `AbortSignal.timeout(EXTERNAL_MODERATION_TIMEOUT_MS)` is constructed later, inside the callback.
   * The deadline therefore starts counting strictly AFTER `start`, so elapsed-at-record is strictly
   * greater than the deadline. Reorder those two — or clamp the recorded duration to the deadline,
   * or start the timer inside the callback — and a capped call starts landing in `le=5`,
   * indistinguishable from a gateway that answered just in time. That is the exact distinction the
   * `timeout` outcome and the 5/7.5 boundary pair exist to draw.
   *
   * 🔴 THE WALL TIME IS THE POINT, AND IS PAID DELIBERATELY. `AbortSignal.timeout` is a Node-native
   * timer that vitest's fake timers do not drive, and running this at a shortened deadline would
   * test a boundary pair (`le=3`/`le=5`) that no deployment uses — the claim in the help text is
   * about the 5 s DEFAULT. So this case really does park for ~5 s. It is one test.
   *
   * The assertion is written as `le=5 is EMPTY` rather than `le=7.5 is 1` on purpose: a loaded
   * runner can stretch the observation past 7.5, which would make the tighter form flaky without
   * making it stronger. "Never counted as sub-cap" is the whole property.
   */
  it('a real 5s abort lands strictly above le=5, never in it', async () => {
    env.EXTERNAL_MODERATION_TIMEOUT_MS = 5000; // the production default, explicitly
    // A gateway that never answers: only the abort can settle this promise.
    vi.stubGlobal('fetch', (_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject((opts.signal as AbortSignal).reason ?? new Error('aborted'))
        );
      });
    });

    await expect(extModeration.moderatePrompt('a hanging prompt', 'generate')).rejects.toBeTruthy();

    // Preconditions — without these the bucket assertion below could pass vacuously by observing
    // nothing at all, or by landing on a different series.
    expect(
      await histCount('generate', 'timeout'),
      'the fired deadline must be recorded exactly once, as outcome=timeout'
    ).toBe(1);
    expect(await histTotalCount()).toBe(1);

    // 🔴 THE PIN. le is INCLUSIVE, so a duration of exactly 5.000 would count here.
    expect(
      await histBucket('generate', 'timeout', 5),
      'a call cut by the 5s deadline must NOT be counted at or below le=5. If it is, a capped ' +
        "call and a call that answered just under the cap share a bucket, the help text's " +
        '"never in le=5" becomes false, and "is the gateway slow or are we cutting it off?" ' +
        'stops being answerable — check that `start` is still taken BEFORE the AbortSignal is ' +
        'constructed, and that the recorded duration is the real elapsed time, unclamped.'
    ).toBe(0);
    expect(
      await histSum('generate', 'timeout'),
      'the recorded duration must be the real elapsed wall time, which exceeds the deadline'
    ).toBeGreaterThan(5);
    // …and it must still land in a FINITE bucket rather than being swallowed by +Inf, which is
    // the other half of why the top boundary sits at 20 and not at the cap.
    expect(
      await histBucket('generate', 'timeout', 20),
      'a capped call must land in a finite bucket, not in +Inf alongside pathological ones'
    ).toBe(1);
    // 🔴 NO PER-TEST TIMEOUT HERE ON PURPOSE. This test parks 5s of REAL time, so it is the one
    // most exposed to a tight bound — and the `unit` project's `testTimeout: 60000` exists
    // precisely because a shorter one produced "a PASS→FAIL that tracked CI load, not code"
    // (see the comment on that setting in `vitest.config.mts`). A third argument here would opt
    // this test DOWN out of that protection. Leave it on the project default.
  });
});

describe('moderatePrompt instrumentation — not configured', () => {
  it('counts the short-circuit separately and leaves the duration histogram untouched', async () => {
    env.EXTERNAL_MODERATION_ENDPOINT = '' as unknown as string;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const r = await extModeration.moderatePrompt('x', 'generate');

    expect(r).toEqual({ flagged: false, categories: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await skippedCount('generate')).toBe(1);
    // Folding a no-I/O call into the latency histogram would drag every quantile toward zero.
    expect(await histTotalCount()).toBe(0);
  });

  it('also short-circuits (and counts) when only the token is missing', async () => {
    env.EXTERNAL_MODERATION_TOKEN = '' as unknown as string;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await extModeration.moderatePrompt('x', 'remixAudit');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await skippedCount('remixAudit')).toBe(1);
    expect(await histTotalCount()).toBe(0);
  });
});
