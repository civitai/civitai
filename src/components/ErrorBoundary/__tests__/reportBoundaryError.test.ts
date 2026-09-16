import { describe, expect, it, vi } from 'vitest';
import {
  BOUNDARY_ERROR_TYPE,
  reportBoundaryError,
} from '~/components/ErrorBoundary/reportBoundaryError';
import { RootErrorBoundary } from '~/components/ErrorBoundary/RootErrorBoundary';

/** A resolved-promise `fetch` double, so `void post(...)?.catch(...)` has something to chain on. */
const okPost = () =>
  vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
    void args;
    return Promise.resolve(new Response(null, { status: 200 }));
  });

const initOf = (post: ReturnType<typeof okPost>) => post.mock.calls[0][1] as RequestInit;
const bodyOf = (post: ReturnType<typeof okPost>) => JSON.parse(initOf(post).body as string);

describe('reportBoundaryError', () => {
  it('pushes the error to Faro, tagged with the boundary that caught it', () => {
    const pushError = vi.fn();
    const err = new Error('boom');

    reportBoundaryError(err, { boundary: 'user', componentStack: '\n at Foo' }, { pushError, post: okPost() });

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(pushError).toHaveBeenCalledWith(err, {
      type: BOUNDARY_ERROR_TYPE,
      context: { boundary: 'user' },
    });
  });

  it('posts message, stack and name to /api/application-error', () => {
    const post = okPost();
    const err = new TypeError('kaboom');

    reportBoundaryError(err, { boundary: 'root', componentStack: '\n at Bar' }, { pushError: vi.fn(), post });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/application-error');
    expect(initOf(post).method).toBe('POST');
    expect(bodyOf(post)).toEqual({ message: 'kaboom', stack: '\n at Bar', name: 'TypeError' });
  });

  // 🔴 The endpoint's zod schema has `stack: z.string()` (required). React's ErrorInfo types
  // `componentStack` as `string | null`, and passing null through drops the key from the JSON
  // body → `schema.parse` throws → 400 → the report is silently lost. That was the behaviour
  // of the inline fetch this helper replaced.
  it('coerces a null componentStack to the error stack rather than sending no stack', () => {
    const post = okPost();
    const err = new Error('no component stack');
    err.stack = 'Error: no component stack\n    at somewhere';

    reportBoundaryError(err, { boundary: 'root', componentStack: null }, { pushError: vi.fn(), post });

    const body = bodyOf(post);
    expect(body.stack).toBe('Error: no component stack\n    at somewhere');
    expect(typeof body.stack).toBe('string');
  });

  it('sends an empty-string stack when neither a component stack nor an error stack exists', () => {
    const post = okPost();
    const err = new Error('stackless');
    err.stack = undefined;

    reportBoundaryError(err, { boundary: 'root' }, { pushError: vi.fn(), post });

    expect(bodyOf(post).stack).toBe('');
    expect('stack' in bodyOf(post)).toBe(true);
  });

  // 🔴 THE SEAM GUARD. The two sinks cover different failure shapes — Faro only works once
  // FaroProvider has mounted, the POST works even when it never did — so neither may be able to
  // suppress the other. Collapsing them into one try/catch, or reordering so a Faro throw
  // escapes first, must fail here.
  it('still posts when Faro throws', () => {
    const post = okPost();
    const pushError = vi.fn(() => {
      throw new Error('faro is not initialised');
    });

    expect(() =>
      reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError, post })
    ).not.toThrow();

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('still pushes to Faro when the POST throws synchronously', () => {
    const pushError = vi.fn();
    const post = vi.fn(() => {
      throw new Error('fetch blew up');
    }) as unknown as typeof fetch;

    expect(() =>
      reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError, post })
    ).not.toThrow();

    expect(pushError).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected POST instead of producing an unhandled rejection', async () => {
    const post = vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

    expect(() =>
      reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError: vi.fn(), post })
    ).not.toThrow();

    // Let the rejection settle; an unhandled one fails the run under Vitest.
    await Promise.resolve();
    await Promise.resolve();
  });

  // 🔴 Pins a subtlety a "cleanup" would otherwise break: the handler does
  // `JSON.parse(req.body)`, so it needs the RAW string. Declaring application/json makes Next's
  // body parser hand it an already-parsed object and `JSON.parse` then throws.
  it('does not declare a JSON content-type, which the raw-body handler depends on', () => {
    const post = okPost();

    reportBoundaryError(new Error('boom'), { boundary: 'root' }, { pushError: vi.fn(), post });

    const headers = (initOf(post).headers ?? {}) as Record<string, string>;
    const names = Object.keys(headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('content-type');
  });

  it('does not throw when neither sink is available', () => {
    expect(() =>
      reportBoundaryError(
        new Error('boom'),
        { boundary: 'root' },
        { pushError: undefined, post: undefined }
      )
    ).not.toThrow();
  });
});

describe('RootErrorBoundary', () => {
  it('flips into its fallback state on any error', () => {
    expect(RootErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true });
  });

  // End-to-end through the REAL reporter (no module mocking): the boundary exists to make an
  // `_app`-render-body throw reportable at all, so this asserts a report actually leaves it,
  // tagged `root` so it is distinguishable in the stream.
  it('reports what it caught through to the POST sink, tagged as the root boundary', () => {
    const post = okPost();
    const original = globalThis.fetch;
    globalThis.fetch = post as unknown as typeof fetch;

    try {
      const boundary = new RootErrorBoundary({ children: null });
      boundary.componentDidCatch(new Error('thrown above every other boundary'), {
        componentStack: '\n at MyAppInner',
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe('/api/application-error');
      expect(bodyOf(post)).toEqual({
        message: 'thrown above every other boundary',
        stack: '\n at MyAppInner',
        name: 'Error',
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
