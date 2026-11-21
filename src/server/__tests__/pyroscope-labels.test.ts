import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetProfileRouteLabelsForTests,
  MAX_DISTINCT_ROUTES,
  OVERFLOW_ROUTE,
  type PprofTime,
  startWallProfilingWithAsyncContext,
  withProfileRoute,
} from '~/server/pyroscope-labels';

// `withProfileRoute` + its arming against a FAKE `@datadog/pprof` `time`. The fake's
// runWithContext is a real AsyncLocalStorage, the same mechanism pprof uses in async-context
// mode, so "the label survives an await" is exercised for real here; that the native profiler
// then writes the label onto its samples is the job of pyroscope-labels.native.test.ts.

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

  it('reuses one context object per route', () => {
    const time = arm();
    withProfileRoute('trpc:x.y', () => 1);
    withProfileRoute('trpc:x.y', () => 1);
    const [first, second] = time.contextCalls;
    expect(first).toBe(second);
  });

  it('caps distinct routes: past the cap every new route shares <overflow>', () => {
    const time = arm();
    for (let i = 0; i < MAX_DISTINCT_ROUTES; i++) withProfileRoute(`trpc:r.${i}`, () => 1);
    expect(withProfileRoute('trpc:r.0', () => labelsOf(time))).toEqual({ route: 'trpc:r.0' });
    expect(withProfileRoute('trpc:new.one', () => labelsOf(time))).toEqual({
      route: OVERFLOW_ROUTE,
    });
    expect(withProfileRoute('trpc:new.two', () => labelsOf(time))).toEqual({
      route: OVERFLOW_ROUTE,
    });
  });
});

describe('call-site ledger', () => {
  // Which requests carry a `route` label is decided by WHERE withProfileRoute is called, and the
  // PR body / profile readers rely on this exact coverage. Fails when a call site is added OR
  // removed, so the coverage statement is updated with it.
  const EXPECTED: Record<string, number> = {
    'src/pages/api/trpc/[trpc].ts': 1, // request level: trpc:<procedure>|batch|other|unknown
    'src/server/trpc.ts': 1, // procedure level: trpc:<path>
    'src/server/utils/endpoint-helpers.ts': 1, // pages API via withApiMetrics: api:<route>
  };

  it('withProfileRoute is called from exactly the ledgered files', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../..');
    const found: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (rel === 'src/server/pyroscope-labels.ts') continue;
          const n = (readFileSync(full, 'utf8').match(/\bwithProfileRoute\s*\(/g) ?? []).length;
          if (n) found[rel] = n;
        }
      }
    };
    walk(path.join(root, 'src'));
    // Positive control: the walk reads real source (this file's own module is under src/).
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(EXPECTED);
  });
});

describe('pyroscopeArmed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([undefined, '', 'false', '1', 'TRUE'])('is false for PYROSCOPE_ENABLED=%j', async (v) => {
    if (v === undefined) vi.stubEnv('PYROSCOPE_ENABLED', undefined as unknown as string);
    else vi.stubEnv('PYROSCOPE_ENABLED', v);
    vi.resetModules();
    expect((await import('~/server/pyroscope-labels')).pyroscopeArmed).toBe(false);
  });

  it("is true only for exactly 'true'", async () => {
    vi.stubEnv('PYROSCOPE_ENABLED', 'true');
    vi.resetModules();
    expect((await import('~/server/pyroscope-labels')).pyroscopeArmed).toBe(true);
  });
});
