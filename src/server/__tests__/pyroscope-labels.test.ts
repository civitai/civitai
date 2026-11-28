import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetProfileRouteLabelsForTests,
  apiProfileRoute,
  rememberResultRoute,
  serializedValueRoute,
  type PprofTime,
  startWallProfilingWithAsyncContext,
  withProfileRoute,
} from '~/server/pyroscope-labels';
import { ROUTE_BUDGET } from '~/server/route-label-budget';

// `withProfileRoute` + its arming against a FAKE `@datadog/pprof` `time`. The fake's
// runWithContext is a real AsyncLocalStorage, the same mechanism pprof uses in async-context
// mode, so "the label survives an await" is exercised for real here; that the native profiler
// then writes the label onto its samples is the job of pyroscope-labels.profiler.test.ts.

type FakeTime = PprofTime & {
  startCalls: Record<string, unknown>[];
  contextCalls: object[];
  store: AsyncLocalStorage<object>;
  started: boolean;
};

function fakeTime({ throwOnAsyncContext = false } = {}): FakeTime {
  const store = new AsyncLocalStorage<object>();
  const t: FakeTime = {
    startCalls: [],
    contextCalls: [],
    store,
    started: false,
    start(options) {
      t.startCalls.push(options);
      if (throwOnAsyncContext && options.useCPED) {
        throw new TypeError('useCPED is not supported on this Node.js version.');
      }
      t.started = true;
    },
    isStarted: () => t.started,
    // A plain generic function, not vi.fn: a Mock erases the generic `R`.
    runWithContext<R>(context: object, fn: () => R): R {
      t.contextCalls.push(context);
      return store.run(context, fn);
    },
  };
  return t;
}

/** What the SDK's startWallProfiling does with pprof: one `time.start` with these options. */
const SDK_START_OPTIONS = { withContexts: true, collectCpuTime: true, intervalMicros: 10_000 };
const sdkStartWall = (time: PprofTime) => () => time.start({ ...SDK_START_OPTIONS });

const labelsOf = (time: FakeTime) =>
  (time.store.getStore() as { labels?: Record<string, string> } | undefined)?.labels;

afterEach(() => {
  __resetProfileRouteLabelsForTests();
  vi.restoreAllMocks();
});

describe('withProfileRoute when dark (labels never armed)', () => {
  it('returns the thunk result itself, unwrapped', () => {
    const value = { sentinel: true };
    expect(withProfileRoute('trpc:a.b', () => value)).toBe(value);
  });

  it('returns the same promise object, so callers awaiting it are unaffected', () => {
    const promise = Promise.resolve(7);
    expect(withProfileRoute('trpc:a.b', () => promise)).toBe(promise);
  });

  it('never evaluates a lazy route', () => {
    const route = vi.fn(() => 'api:GET /api/x');
    withProfileRoute(route, () => 1);
    expect(route).not.toHaveBeenCalled();
  });

  it('starts no context: a later-armed runner sees no call from a dark-time wrap', () => {
    const time = fakeTime();
    withProfileRoute('trpc:dark.call', () => 1);
    startWallProfilingWithAsyncContext(sdkStartWall(time), time);
    expect(time.contextCalls).toEqual([]);
  });
});

describe('startWallProfilingWithAsyncContext', () => {
  it('starts pprof with useCPED:true on top of the SDK options, exactly once', () => {
    const time = fakeTime();
    expect(startWallProfilingWithAsyncContext(sdkStartWall(time), time)).toBe(true);
    expect(time.startCalls).toEqual([{ ...SDK_START_OPTIONS, useCPED: true }]);
  });

  it('restores the original time.start afterwards', () => {
    const time = fakeTime();
    const original = time.start;
    startWallProfilingWithAsyncContext(sdkStartWall(time), time);
    expect(time.start).toBe(original);
  });

  it('falls back to a plain start, labels off, when async-context mode throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const time = fakeTime({ throwOnAsyncContext: true });
    expect(startWallProfilingWithAsyncContext(sdkStartWall(time), time)).toBe(false);
    expect(time.startCalls).toEqual([{ ...SDK_START_OPTIONS, useCPED: true }, SDK_START_OPTIONS]);
    expect(time.started).toBe(true);
    withProfileRoute('trpc:a.b', () => 1);
    expect(time.contextCalls).toEqual([]);
  });

  it('leaves labels off when the SDK started a DIFFERENT pprof copy', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ours = fakeTime();
    const sdkCopy = fakeTime();
    expect(startWallProfilingWithAsyncContext(sdkStartWall(sdkCopy), ours)).toBe(false);
    expect(ours.startCalls).toEqual([]);
    withProfileRoute('trpc:a.b', () => 1);
    expect(ours.contextCalls).toEqual([]);
  });

  it('starts plainly, labels off, when pprof could not be loaded', () => {
    const startWall = vi.fn();
    expect(startWallProfilingWithAsyncContext(startWall, undefined)).toBe(false);
    expect(startWall).toHaveBeenCalledTimes(1);
  });
});

describe('withProfileRoute when armed', () => {
  function arm() {
    const time = fakeTime();
    expect(startWallProfilingWithAsyncContext(sdkStartWall(time), time)).toBe(true);
    return time;
  }

  it('runs a tRPC procedure under route=trpc:<path>', () => {
    const time = arm();
    const seen = withProfileRoute('trpc:image.getInfinite', () => labelsOf(time));
    expect(seen).toEqual({ route: 'trpc:image.getInfinite' });
  });

  it('keeps the label after an await (the continuation, not just the sync prefix)', async () => {
    const time = arm();
    const seen = await withProfileRoute('trpc:model.getAll', async () => {
      await sleep(1);
      await Promise.resolve();
      return labelsOf(time);
    });
    expect(seen).toEqual({ route: 'trpc:model.getAll' });
  });

  it('does not leak a label to concurrent work outside the scope', async () => {
    const time = arm();
    const inside = withProfileRoute('trpc:a.inside', async () => {
      await sleep(5);
      return labelsOf(time);
    });
    const outside = (async () => {
      await sleep(1);
      return labelsOf(time);
    })();
    expect(await outside).toBeUndefined();
    expect(await inside).toEqual({ route: 'trpc:a.inside' });
  });

  it('lets an inner scope (the procedure) override the outer one (the request)', async () => {
    const time = arm();
    const labelsAfterAwait = async () => {
      await sleep(1);
      return labelsOf(time);
    };
    const seen = await withProfileRoute('trpc:batch', async () => {
      const outer = labelsOf(time);
      const inner = await Promise.all([
        withProfileRoute('trpc:one.a', labelsAfterAwait),
        withProfileRoute('trpc:two.b', labelsAfterAwait),
      ]);
      return [outer, ...inner, labelsOf(time)];
    });
    // Outer label before and after the inner scopes; each inner scope sees its own.
    expect(seen).toEqual([
      { route: 'trpc:batch' },
      { route: 'trpc:one.a' },
      { route: 'trpc:two.b' },
      { route: 'trpc:batch' },
    ]);
  });

  it('evaluates a lazy route once per call and labels with its value', () => {
    const time = arm();
    const route = vi.fn(() => 'api:GET /api/v1/images');
    expect(withProfileRoute(route, () => labelsOf(time))).toEqual({
      route: 'api:GET /api/v1/images',
    });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('exhausting the api budget leaves tRPC labels intact', () => {
    const time = arm();
    for (let i = 0; i < ROUTE_BUDGET.api; i++) withProfileRoute(`api:GET /api/v1/r${i}`, () => 1);
    expect(withProfileRoute('api:GET /api/v1/r0', () => labelsOf(time))).toEqual({
      route: 'api:GET /api/v1/r0',
    });
    expect(withProfileRoute('api:GET /api/v1/new', () => labelsOf(time))).toEqual({
      route: 'api:<overflow>',
    });
    expect(withProfileRoute('trpc:image.getInfinite', () => labelsOf(time))).toEqual({
      route: 'trpc:image.getInfinite',
    });
  });

  it('past the tRPC budget new procedures share trpc:<overflow>, api routes unaffected', () => {
    const time = arm();
    for (let i = 0; i < ROUTE_BUDGET.trpc; i++) withProfileRoute(`trpc:r.${i}`, () => 1);
    expect(withProfileRoute('trpc:r.0', () => labelsOf(time))).toEqual({ route: 'trpc:r.0' });
    expect(withProfileRoute('trpc:new.one', () => labelsOf(time))).toEqual({
      route: 'trpc:<overflow>',
    });
    expect(withProfileRoute('trpc:new.two', () => labelsOf(time))).toEqual({
      route: 'trpc:<overflow>',
    });
    expect(withProfileRoute('api:GET /api/v1/x', () => labelsOf(time))).toEqual({
      route: 'api:GET /api/v1/x',
    });
  });
});

describe('apiProfileRoute', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('keeps %s', (m) => {
    expect(apiProfileRoute(`${m} /api/v1/images`)).toBe(`api:${m} /api/v1/images`);
  });

  it('maps an unknown method to one bucket', () => {
    expect(apiProfileRoute('PROPFIND /api/v1/images')).toBe('api:OTHER /api/v1/images');
    expect(apiProfileRoute('XYZZY /api/v1/images')).toBe('api:OTHER /api/v1/images');
  });
});

describe('rememberResultRoute / serializedValueRoute', () => {
  const arm = () => {
    const time = fakeTime();
    startWallProfilingWithAsyncContext(sdkStartWall(time), time);
  };
  // A tRPC stream chunk carrying a resolved value: `[index, status, [[value], ...asyncs]]`.
  const chunk = (value: unknown) => [7, 0, [[value]]];
  // What tRPC's stream encoder sends for a plain-object value: a null-prototype shallow copy.
  const streamCopy = (value: Record<string, unknown>) =>
    Object.assign(Object.create(null) as Record<string, unknown>, value);

  it('is dark until armed: nothing is remembered or found', () => {
    const data = { items: [1] };
    rememberResultRoute({ ok: true, data }, 'trpc:image.getInfinite');
    expect(serializedValueRoute(data)).toBeUndefined();
    arm();
    expect(serializedValueRoute(data)).toBeUndefined();
  });

  it('finds the value itself (a non-streamed batch serializes result.data)', () => {
    arm();
    const data = { items: [1], nextCursor: 3 };
    rememberResultRoute({ ok: true, data }, 'trpc:image.getInfinite');
    expect(serializedValueRoute(data)).toBe('trpc:image.getInfinite');
  });

  it('finds an array value inside a stream chunk (the encoder keeps it as is)', () => {
    arm();
    const data = [{ id: 1 }, { id: 2 }];
    rememberResultRoute({ ok: true, data }, 'trpc:tag.getAll');
    expect(serializedValueRoute(chunk(data))).toBe('trpc:tag.getAll');
  });

  it("finds a plain-object value through the stream's shallow copy, by its first object field", () => {
    arm();
    const data = { nextCursor: 9, items: [{ id: 1 }] };
    rememberResultRoute({ ok: true, data }, 'trpc:homeBlock.getHomeBlock');
    expect(serializedValueRoute(chunk(streamCopy(data)))).toBe('trpc:homeBlock.getHomeBlock');
  });

  it('keeps two procedures of one batch apart', () => {
    arm();
    const a = { items: [{ id: 1 }] };
    const b = { items: [{ id: 2 }] };
    rememberResultRoute({ ok: true, data: a }, 'trpc:model.getAll');
    rememberResultRoute({ ok: true, data: b }, 'trpc:user.getCreator');
    expect(serializedValueRoute(chunk(streamCopy(b)))).toBe('trpc:user.getCreator');
    expect(serializedValueRoute(chunk(streamCopy(a)))).toBe('trpc:model.getAll');
  });

  it('remembers nothing for a failed result or a primitive value', () => {
    arm();
    const data = { items: [1] };
    rememberResultRoute({ ok: false, error: new Error('x'), data }, 'trpc:a.fail');
    rememberResultRoute({ ok: true, data: 5 }, 'trpc:a.count');
    expect(serializedValueRoute(data)).toBeUndefined();
    expect(serializedValueRoute(5)).toBeUndefined();
  });

  it("does not find the stream's envelope chunks or a value with no object field", () => {
    arm();
    const data = { count: 5 };
    rememberResultRoute({ ok: true, data }, 'trpc:a.count');
    expect(serializedValueRoute(chunk(streamCopy(data)))).toBeUndefined();
    expect(serializedValueRoute(chunk(streamCopy({ result: 0 })))).toBeUndefined();
    expect(serializedValueRoute({ '0': [[0], [null, 0, 0]] })).toBeUndefined();
  });

  it('looks at no more than the first 8 fields of a plain-object value', () => {
    arm();
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i]));
    const late = { ...fields, items: [{ id: 1 }] };
    rememberResultRoute({ ok: true, data: late }, 'trpc:a.wide');
    expect(serializedValueRoute(chunk(streamCopy(late)))).toBeUndefined();
    const early = { f0: 0, items: [{ id: 1 }] };
    rememberResultRoute({ ok: true, data: early }, 'trpc:a.narrow');
    expect(serializedValueRoute(chunk(streamCopy(early)))).toBe('trpc:a.narrow');
  });
});
