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

describe('a call cut by the REAL abort deadline, at the production default', () => {
  /** The production default deadline, in seconds (`EXTERNAL_MODERATION_TIMEOUT_MS` = 5000). */
  const CAP_SECONDS = 5;

  /**
   * 🔴 WHAT THIS CASE PINS, AND THE CLAIM IT USED TO PIN AND NO LONGER DOES.
   *
   * It used to assert "a real 5s abort lands strictly above le=5, never in it" — i.e. that a capped
   * call is identifiable by which BUCKET it falls in. That assertion is deleted because the claim is
   * FALSE, not because it was inconvenient. Measured at the commit that introduced it, isolated and
   * unloaded, it failed 2 of 8 and 2 of 10 runs, with wall time identical (5.23-5.27 s) across
   * passing and failing runs — a boundary problem, not a load flake.
   *
   * THE MECHANISM. `le` is INCLUSIVE. `AbortSignal.timeout()` fires off a libuv timer while the
   * recorded duration is a `performance.now()` delta, and those two clocks disagree by a small fixed
   * offset — so the elapsed time measured at the moment the deadline fires can land just BELOW the
   * deadline and be counted in `le=5`. Directly measured on one host: 3/60 samples at a 100 ms
   * deadline and 3/8 at 5000 ms came in EARLY, worst case 0.63 ms; the same magnitude at both
   * deadlines, i.e. a constant offset rather than a clock-rate difference. Taking `start` before the
   * `AbortSignal` is constructed (which `moderatePrompt` does) biases the other way by a few
   * microseconds — nowhere near enough to win that race.
   *
   * AND IT IS NOT FIXABLE BY MOVING THE BOUNDARY. Two calls, one that answered a microsecond under
   * the cap and one cut BY the cap, are arbitrarily close in duration; no bucket edge lies between
   * them. The deadline is env-tunable (`.min(100).max(60000)`), so no fixed bucket set can hold any
   * boundary relationship to it across deployments either. `outcome="timeout"` separates the two
   * populations perfectly and deterministically — it is a branch on the abort error
   * (`isAbortDeadlineError`), never on the duration — and it always did. The bucket boundary was
   * never load-bearing for that question, which is why the help text no longer claims it is.
   *
   * SO WHAT IS LEFT HERE IS WHAT IS ACTUALLY TRUE AND STABLE: a call cut by the deadline is recorded
   * exactly once, classified `timeout` (not `error`), carrying the real parked wall time, in a
   * FINITE bucket. `external-moderation.metrics.test.ts` pins the bucket SET by hand-feeding numbers
   * and so cannot see any of this; the two files together are the claim.
   *
   * 🔴 THE WALL TIME IS THE POINT AND IS PAID DELIBERATELY. `AbortSignal.timeout` is a Node-native
   * timer that vitest's fake timers do not drive, so the park is real. Running it at a shortened
   * deadline would exercise a value no deployment uses; at 5000 it drives the configured production
   * default, which is what makes the finite-bucket assertion below meaningful. It is one test.
   */
  it('is recorded once as outcome=timeout, with the real parked duration, in a finite bucket', async () => {
    env.EXTERNAL_MODERATION_TIMEOUT_MS = CAP_SECONDS * 1000; // the production default, explicitly
    // A gateway that never answers: only the abort can settle this promise.
    vi.stubGlobal('fetch', (_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject((opts.signal as AbortSignal).reason ?? new Error('aborted'))
        );
      });
    });

    await expect(extModeration.moderatePrompt('a hanging prompt', 'generate')).rejects.toBeTruthy();

    // 🔴 THE CLASSIFICATION IS THE WHOLE SEPARATOR NOW, so it is pinned from both sides: the
    // timeout series moved, and the error series did not. Asserting only the first would still pass
    // if a fired deadline were ALSO counted as an error.
    expect(
      await histCount('generate', 'timeout'),
      'a call cut by the abort deadline must be recorded exactly once as outcome=timeout — that ' +
        'label is the only thing that distinguishes a capped call from a slow one, since their ' +
        'durations are arbitrarily close and no bucket edge separates them'
    ).toBe(1);
    expect(
      await histCount('generate', 'error'),
      'a fired deadline must NOT also land on outcome=error: the two call for opposite responses ' +
        '(re-size the deadline vs. fix the gateway), so merging them makes the label useless'
    ).toBe(0);
    expect(
      await histTotalCount(),
      'exactly one observation across EVERY series — a fired deadline reaches the recorder through ' +
        'the catch path only, never additionally through a finally'
    ).toBe(1);

    // The recorded duration must be the REAL parked wall time. Expressed as a band around the
    // deadline rather than a strict `> CAP`: the clock offset documented above means a genuine
    // fired deadline legitimately measures a fraction of a millisecond short, so `> 5` is the
    // flaky assertion this case used to carry, in another spelling. The floor is 50 ms of slack —
    // ~80x the worst offset measured (0.63 ms), and load can only push this number UP (a jammed
    // event loop makes the abort land late, never early), so the floor is not load-exposed.
    const seconds = await histSum('generate', 'timeout');
    expect(
      seconds,
      `the recorded duration must be the real elapsed wall time of the full ${CAP_SECONDS}s park; ` +
        'a placeholder, a zero, or a timer started after the request was issued reads far below this'
    ).toBeGreaterThanOrEqual(CAP_SECONDS - 0.05);
    expect(
      seconds,
      'the duration must be recorded in SECONDS, not milliseconds — a ms-valued observation reads ' +
        `~${CAP_SECONDS * 1000} here and would silently place every call in +Inf`
    ).toBeLessThan(CAP_SECONDS * 2);

    // 🔴 THE BUCKET PROPERTY THAT IS SOUND, driven end to end at the real cap: a capped call must
    // land in a FINITE bucket. This one does not depend on any clock — it is why the top finite
    // boundary sits at 20 and not at the deadline. If it ever fails, every capped call is in +Inf
    // alongside every pathological one and the tail is unreadable.
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
