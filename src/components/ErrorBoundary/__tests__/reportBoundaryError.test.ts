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

  it.each(throwables)('posts a body satisfying the endpoint schema when given %s', (_n, thrown) => {
    withFetch((f) => {
      reportBoundaryError(thrown, { boundary: 'user', componentStack: '\n at Foo' });
      expect(f).toHaveBeenCalledTimes(1);
      const parsed = applicationErrorSchema.safeParse(bodyOf(f));
      expect(parsed.success).toBe(true);
    });
  });

  // 🔴 ALERTING INVARIANT, not a style choice. The endpoint defaults an absent `name` to the
  // literal `application-error`, and the two server-side log alerts on this signal select on
  // exactly that value — one at critical severity, routed to the on-call pager. Setting any `name`
  // silently removes boundary errors from both populations. This guard fails if someone "follows
  // the convention" that every other caller uses.
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

  // 🔴 The handler does `JSON.parse(req.body)`, so it needs the RAW string. Declaring
  // application/json makes Next's body parser hand it an object and that parse throws.
  it('does not declare a JSON content-type, which the raw-body handler depends on', () => {
    withFetch((f) => {
      reportBoundaryError(new Error('boom'), { boundary: 'user' });
      const headers = (initOf(f).headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
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
    'reaches both sinks for a non-Error throw (%p)',
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
