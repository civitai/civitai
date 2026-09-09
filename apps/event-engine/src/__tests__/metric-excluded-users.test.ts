// Deliberately outside `src/common`, for the reason given at the top of
// signals.test.ts: `src/common` is a hand-vendored copy of event-engine-common and a
// re-vendor would clobber a test living there.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MetricExcludedUsers } from '@/services/metric-excluded-users';
import { RedisCache } from '@/services/redis-cache';
import { EventProcessor } from '@/services/event-processor';
import { metricSignals } from '@/services/metric-signals';
import type { CacheUpdate, MetricEvent } from '@/types/events';

type Row = { userId: number | string };

/** Minimal stand-in for the ClickHouse client SimpleClickhouse wraps. */
function chReturning(...responses: (Row[] | Error | undefined)[]) {
  let call = 0;
  return {
    query: async () => {
      const next = responses[Math.min(call++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { json: async () => next, text: async () => '', stream: () => undefined };
    },
  } as never;
}

type IncrCall = { key: string; field: string; value: number };

function cacheWithFakeRedis(excluded: MetricExcludedUsers) {
  const incr: IncrCall[] = [];
  const incrOnce: IncrCall[] = [];
  const client = {
    run: async (commands: unknown[]) => commands,
    hIncrIfExists: (key: string, field: string, value: number) => {
      incr.push({ key, field, value });
      return Promise.resolve(1);
    },
    hIncrIfExistsOnce: (key: string, _dedupeKey: string, field: string, value: number) => {
      incrOnce.push({ key, field, value });
      return Promise.resolve(true);
    },
  };
  const cache = new RedisCache('redis://unused', excluded);
  // Bypass connect(): it would dial a real host.
  (cache as unknown as { client: unknown }).client = client;
  (cache as unknown as { isConnected: boolean }).isConnected = true;
  return { cache, incr, incrOnce };
}

function update(userId: number | string, metricType = 'Like'): CacheUpdate {
  return {
    entityId: 141298569,
    entityType: 'Image',
    metricType,
    metricValue: 1,
    userId: userId as number,
  };
}

function event(userId: number | string, metricType = 'Like'): MetricEvent {
  return {
    ...update(userId, metricType),
    timestamp: new Date('2026-09-02T17:39:23Z'),
  };
}

async function loaded(...userIds: (number | string)[]) {
  const list = new MetricExcludedUsers(chReturning(userIds.map((userId) => ({ userId }))), 60_000);
  await list.refresh();
  return list;
}

describe('MetricExcludedUsers', () => {
  test('has() matches loaded ids and nothing else, and never matches a missing userId', async () => {
    const list = await loaded(6680940, 7472843);

    expect(list.has(6680940)).toBe(true);
    expect(list.has(7472843)).toBe(true);
    expect(list.has(9999999)).toBe(false);
    // A CacheUpdate may carry userId null/undefined; those must not be treated as
    // excluded or every anonymous-ish update would stop counting. '' matters
    // separately because Number('') is 0, not NaN.
    expect(list.has(null)).toBe(false);
    expect(list.has(undefined)).toBe(false);
    expect(list.has('')).toBe(false);
    expect(list.size).toBe(2);
  });

  // clickhouse-js returns 64-bit integer columns as JS STRINGS, and
  // handlers/manual/update-compensation.ts casts raw ClickHouse rows straight to
  // CacheUpdate. Without coercion `Set<number>.has('6680940')` is false, the farm
  // user is counted, and typecheck/lint/every other test still pass.
  test('has() matches a userId that arrives as a string', async () => {
    const list = await loaded(6680940);

    expect(list.has('6680940')).toBe(true);
    expect(list.has('not-a-number')).toBe(false);
  });

  // `Number(null)` and `Number('')` coerce to 0, so junk rows would otherwise enter
  // the set as 0 — the id update-compensation writes on its model-earnings rows.
  test('userId 0 is never admitted to the set', async () => {
    const list = await loaded(0, 6680940);

    expect(list.has(0)).toBe(false);
    expect(list.size).toBe(1);
  });

  test('a failed refresh keeps the previous set rather than counting farm users again', async () => {
    const list = new MetricExcludedUsers(
      chReturning([{ userId: 6680940 }], new Error('clickhouse unreachable')),
      60_000
    );

    await list.refresh();
    expect(list.has(6680940)).toBe(true);

    await list.refresh(); // throws internally
    expect(list.has(6680940)).toBe(true);
    expect(list.size).toBe(1);
  });

  // SimpleClickhouse casts `await response?.json()` to T[] through an optional
  // chain, so a nullish response is TYPED as an array and is not one. Iterating it
  // would throw out of a `void`ed interval callback and take the pod down, which
  // is not what a method documented as "does not throw" should do.
  test('a non-array response is handled, not thrown out of refresh', async () => {
    const list = new MetricExcludedUsers(chReturning([{ userId: 6680940 }], undefined), 60_000);

    await list.refresh();
    await expect(list.refresh()).resolves.toBeUndefined();
    expect(list.has(6680940)).toBe(true);
  });

  // Do not re-add the empty-result guard — see metric-excluded-users.ts refresh().
  test('an empty successful refresh clears the list and does not strand suppressions', async () => {
    const list = new MetricExcludedUsers(chReturning([{ userId: 6680940 }], []), 60_000);

    await list.refresh();
    expect(list.size).toBe(1);

    await list.refresh();
    expect(list.size).toBe(0);
    expect(list.has(6680940)).toBe(false);
  });

  // An unparseable METRIC_EXCLUSION_REFRESH_MS reaches this constructor as NaN,
  // and setInterval clamps a NaN delay to 1ms — a ClickHouse query loop from every
  // pod, invisible because refresh() swallows its own errors.
  test('a NaN or tiny refresh interval is floored, not passed to setInterval', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const list = new MetricExcludedUsers(chReturning([]), Number.NaN);
    await list.start();
    list.stop();

    expect(spy.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(1000);

    const tiny = new MetricExcludedUsers(chReturning([]), 5);
    await tiny.start();
    tiny.stop();

    expect(spy.mock.calls[1]?.[1]).toBeGreaterThanOrEqual(1000);
  });
});

describe('RedisCache respects the exclusion list', () => {
  test('increment() drops excluded users and still applies the rest', async () => {
    const excluded = await loaded(6680940, 7472843);
    const { cache, incr } = cacheWithFakeRedis(excluded);

    await cache.increment([update(6680940), update(111, 'Heart'), update(7472843)]);

    expect(incr).toEqual([{ key: 'metrics:Image:141298569', field: 'Heart', value: 1 }]);
  });

  test('increment() issues no Redis command at all when every update is excluded', async () => {
    const excluded = await loaded(6680940);
    const { cache, incr } = cacheWithFakeRedis(excluded);

    await cache.increment(update(6680940));

    expect(incr).toEqual([]);
  });

  // The filter runs BEFORE connect(), so a fully-excluded batch never dials Redis.
  // Asserted by making connect() fail loudly: move dropExcluded below the connect
  // block and this throws instead of returning.
  test('a fully-excluded batch returns without connecting', async () => {
    const excluded = await loaded(6680940);
    const cache = new RedisCache('redis://unused', excluded);
    (cache as unknown as { connect: () => Promise<void> }).connect = async () => {
      throw new Error('connect() must not be reached for a fully-excluded batch');
    };

    await expect(cache.increment(update(6680940))).resolves.toBeUndefined();
  });

  test('incrementOnce() skips an excluded user and applies a kept one', async () => {
    const excluded = await loaded(6680940);
    const { cache, incrOnce } = cacheWithFakeRedis(excluded);

    await cache.incrementOnce(event(6680940));
    await cache.incrementOnce(event(111, 'Heart'));

    expect(incrOnce).toEqual([{ key: 'metrics:Image:141298569', field: 'Heart', value: 1 }]);
  });
});

// Asserted at the CALL SITES in createActions, not on the predicate: a `has()` test
// passes while the delta goes out unfiltered. Both sites are covered on purpose — an
// earlier revision covered only addMetricEvent, and the ungated-incMetricCache mutant
// passed the whole suite.
describe('live metric signals respect the exclusion list', () => {
  let restoreSignals: (() => void) | null = null;

  afterEach(() => {
    restoreSignals?.();
    restoreSignals = null;
  });

  function actionsWith(excluded: MetricExcludedUsers) {
    const sent: (number | string)[] = [];
    const batched: (number | string)[] = [];
    const original = metricSignals.sendDelta;
    // Patched before anything that can throw, and released in afterEach: a throw
    // between here and the assertions would otherwise leave the singleton patched
    // for the rest of the file and poison the next test's `original`.
    metricSignals.sendDelta = (async (upd: CacheUpdate) => {
      sent.push(upd.userId as number);
    }) as typeof metricSignals.sendDelta;
    restoreSignals = () => {
      metricSignals.sendDelta = original;
    };

    const proc = Object.create(EventProcessor.prototype) as EventProcessor;
    Object.assign(proc, {
      excludedUsers: excluded,
      redisCache: { increment: async () => undefined, incrementOnce: async () => undefined },
      metricBatcher: {
        add: (ev: MetricEvent) => {
          batched.push(ev.userId as number);
        },
      },
    });

    const actions = (
      proc as unknown as {
        createActions(
          meta: unknown,
          ts: Date
        ): {
          addMetricEvent(e: MetricEvent): void;
          incMetricCache(u: CacheUpdate | CacheUpdate[]): Promise<void>;
        };
      }
    ).createActions({ topic: 't', partition: 0, offset: '0' }, new Date());

    return { actions, sent, batched };
  }

  test('addMetricEvent broadcasts a kept user and not an excluded one', async () => {
    const excluded = await loaded(6680940);
    const { actions, sent } = actionsWith(excluded);

    actions.addMetricEvent(event(6680940));
    actions.addMetricEvent(event(111, 'Heart'));

    expect(sent).toEqual([111]);
  });

  test('incMetricCache broadcasts a kept user and not an excluded one', async () => {
    const excluded = await loaded(6680940);
    const { actions, sent } = actionsWith(excluded);

    await actions.incMetricCache(update(6680940));
    await actions.incMetricCache(update(111, 'Heart'));

    expect(sent).toEqual([111]);
  });

  // Suppression is a read-side concern. The raw ClickHouse event table is what the
  // aggregate filters FROM and what metric-reaction-repair reconciles against, so
  // dropping these rows would break the thing that makes the count correct.
  test('an excluded user still reaches the ClickHouse batch', async () => {
    const excluded = await loaded(6680940);
    const { actions, batched } = actionsWith(excluded);

    actions.addMetricEvent(event(6680940));

    expect(batched).toEqual([6680940]);
  });
});
