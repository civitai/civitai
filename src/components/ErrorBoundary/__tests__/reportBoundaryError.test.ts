import { describe, expect, it, vi } from 'vitest';
import { reportBoundaryError } from '~/components/ErrorBoundary/reportBoundaryError';
import { applicationErrorSchema } from '~/pages/api/application-error';

/** A resolved-promise `fetch` double, so the reporter's fire-and-forget `.catch` has a target. */
const okFetch = () =>
  vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
    void args;
    return Promise.resolve(new Response(null, { status: 200 }));
  });

const initOf = (f: ReturnType<typeof okFetch>) => f.mock.calls[0][1] as RequestInit;
const bodyOf = (f: ReturnType<typeof okFetch>) => JSON.parse(initOf(f).body as string);

/**
 * Runs the reporter through the REAL `reportApplicationError`, intercepting only `globalThis.fetch`
 * — so what these tests inspect is the actual wire body, not a stub's arguments.
 */
function withFetch(fn: (f: ReturnType<typeof okFetch>) => void) {
  const f = okFetch();
  const original = globalThis.fetch;
  globalThis.fetch = f as unknown as typeof fetch;
  try {
    fn(f);
  } finally {
    globalThis.fetch = original;
  }
}

describe('reportBoundaryError — the POST sink', () => {
  // 🔴 THE STRUCTURAL GUARD. Pins the RELATIONSHIP "whatever we post satisfies the endpoint's
  // contract" against the endpoint's OWN schema, for every throw shape a boundary can see —
  // rather than pinning two hand-picked `stack` strings, which is walkable by any input the
  // fixtures did not imagine. A body that fails this is a 400, and `fetch` does not reject on a
  // 4xx, so the report would vanish with nothing to observe.
  const throwables: [name: string, thrown: unknown][] = [
    ['an ordinary Error', new Error('boom')],
    ['a TypeError', new TypeError('kaboom')],
    ['an Error with no stack', Object.assign(new Error('stackless'), { stack: undefined })],
    ['an Error with an undefined message', Object.assign(new Error(), { message: undefined })],
    ['a bare string', 'just a string'],
    ['a plain object', { code: 'E_X' }],
    ['null', null],
    ['undefined', undefined],
  ];

  // 🔴 The componentStack is PARAMETERISED, and that is load-bearing rather than thorough.
  // `_error.tsx` — the only call site for `boundary: 'root'` — passes NO componentStack, so a
  // matrix that supplied one for every fixture made `ctx.stack` always truthy and left the
  // `?? ''` stack fallback in `reportApplicationError` unreachable. Measured: removing that
  // fallback kept the whole suite green, while the real `root` shape (no componentStack, stackless
  // error) posted a body with NO `stack` key at all → 400 → report silently lost, which is the
  // exact hazard this guard is named for. A fixture constant was short-circuiting the branch.
  const stacks: [label: string, componentStack: string | null | undefined][] = [
    ['with a componentStack', '\n at Foo'],
    ['with a null componentStack', null],
    ['with NO componentStack (the `root` shape)', undefined],
  ];
  const matrix = throwables.flatMap(([tn, thrown]) =>
    stacks.map(([sn, cs]) => [`${tn} ${sn}`, thrown, cs] as const)
  );

  it.each(matrix)('posts a body satisfying the endpoint schema given %s', (_n, thrown, cs) => {
    withFetch((f) => {
      reportBoundaryError(thrown, { boundary: 'user', componentStack: cs });
      expect(f).toHaveBeenCalledTimes(1);
      const parsed = applicationErrorSchema.safeParse(bodyOf(f));
      expect(parsed.success).toBe(true);
    });
  });

  // 🔴 ALERTING INVARIANT, not a style choice. The endpoint defaults an absent `name` to the
  // literal `application-error`, and log-based alerting keys off that value, so setting any `name`
  // silently moves these reports into a different population. This guard fails if someone "follows
  // the convention" that every other caller uses. (Alert specifics live in the infra repo.)
  it.each(throwables)('does not set a name, keeping the alert population, for %s', (_n, thrown) => {
    withFetch((f) => {
      reportBoundaryError(thrown, { boundary: 'user' });
      expect(bodyOf(f).name).toBeUndefined();
    });
  });

  it('carries the boundary identity in the message instead', () => {
    withFetch((f) => {
      reportBoundaryError(new Error('boom'), { boundary: 'game' });
      expect(bodyOf(f).message).toContain('error boundary: game');
      expect(bodyOf(f).message).toContain('boom');
    });
  });

  it('sends the componentStack as the stack when there is one', () => {
    withFetch((f) => {
      reportBoundaryError(new Error('boom'), { boundary: 'user', componentStack: '\n at Bar' });
      expect(bodyOf(f).stack).toBe('\n at Bar');
    });
  });

  // 🔴 AMPLIFICATION GUARD. With no componentStack, the body carries the error's REAL minified
  // stack, and resolving one server-side is an uncached multi-megabyte read+parse ON the request
  // path. A caller that fires once per failed render would make the instrumentation amplify the
  // outage it exists to observe, on the pool that serves pages. Keyed on the componentStack rather
  // than the boundary name so a new caller inherits it.
  it.each(throwables)(
    'declines server-side stack resolution with no componentStack, for %s',
    (_n, thrown) => {
      withFetch((f) => {
        reportBoundaryError(thrown, { boundary: 'root' });
        expect(bodyOf(f).resolveStack).toBe(false);
      });
    }
  );

  // The mirror half: with a componentStack there are no file frames, so the resolver is a no-op and
  // we must NOT opt out — that keeps the body byte-identical to what every other caller sends.
  it('does NOT decline resolution when a componentStack is supplied', () => {
    withFetch((f) => {
      reportBoundaryError(new Error('boom'), { boundary: 'user', componentStack: '\n at Bar' });
      expect('resolveStack' in bodyOf(f)).toBe(false);
    });
  });

  // 🔴 The handler does `JSON.parse(req.body)`, so it needs the RAW string. Declaring
  // application/json makes Next's body parser hand it an object and that parse throws.
  // Read through `new Headers(...)`, NOT `Object.keys`. `Object.keys` only sees a plain object, so
  // it is blind to the two other legal `HeadersInit` shapes — measured: both
  // `new Headers({'Content-Type': 'application/json'})` and `[['Content-Type', ...]]` walked the
  // previous version of this guard with the suite fully green, while breaking the handler exactly
  // as a plain object would.
  it('does not declare a JSON content-type, which the raw-body handler depends on', () => {
    withFetch((f) => {
      reportBoundaryError(new Error('boom'), { boundary: 'user' });
      expect(new Headers(initOf(f).headers ?? {}).get('content-type')).toBeNull();
    });
  });
});

describe('reportBoundaryError — the Faro sink', () => {
  // 🔴 Faro core resolves `type: type || error.name || <default>`, and
  // `~/utils/faro/classifyException` keys its `chunkload`/`meili` rules off that field. Passing a
  // `type` would replace the error class and misclassify a boundary-caught ChunkLoadError as a
  // real app error — inflating one alert and removing it from another.
  it('does NOT pass a type, so the error class survives for the classifier', () => {
    const pushError = vi.fn();
    reportBoundaryError(new Error('boom'), { boundary: 'user' }, { pushError, report: vi.fn() });

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(pushError.mock.calls[0][1]).not.toHaveProperty('type');
  });

  it('tags the beacon with the boundary in context', () => {
    const pushError = vi.fn();
    reportBoundaryError(new Error('boom'), { boundary: 'game' }, { pushError, report: vi.fn() });
    expect(pushError.mock.calls[0][1]).toEqual({ context: { boundary: 'game' } });
  });

  it('normalizes a non-Error throw before handing it to Faro', () => {
    const pushError = vi.fn();
    reportBoundaryError(null, { boundary: 'root' }, { pushError, report: vi.fn() });
    expect(pushError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('reportBoundaryError — sink independence', () => {
  // 🔴 THE SEAM GUARD. The sinks reach different consumers, so neither may be able to suppress the
  // other. Collapsing the two try/catch blocks into one, or letting a shared expression above them
  // throw, must fail here.
  it('still reports to the POST sink when Faro throws', () => {
    const report = vi.fn();
    const pushError = vi.fn(() => {
      throw new Error('faro is not initialised');
    });

    expect(() =>
      reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError, report })
    ).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('still pushes to Faro when the POST sink throws', () => {
    const pushError = vi.fn();
    const report = vi.fn(() => {
      throw new Error('fetch blew up');
    });

    expect(() =>
      reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError, report })
    ).not.toThrow();
    expect(pushError).toHaveBeenCalledTimes(1);
  });

  // The shape that escaped the previous version: a non-Error throw made a shared expression above
  // both try blocks throw, killing both sinks at once.
  it.each([[null], [undefined], [{ code: 'E_X' }], ['a string']])(
    'reaches both sinks for a non-Error throw (%j)',
    (thrown) => {
      const pushError = vi.fn();
      const report = vi.fn();
      expect(() =>
        reportBoundaryError(thrown, { boundary: 'root' }, { pushError, report })
      ).not.toThrow();
      expect(pushError).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
    }
  );

  it('does not throw when neither sink is available', () => {
    expect(() =>
      reportBoundaryError(
        new Error('boom'),
        { boundary: 'root' },
        { pushError: undefined, report: undefined }
      )
    ).not.toThrow();
  });
});
