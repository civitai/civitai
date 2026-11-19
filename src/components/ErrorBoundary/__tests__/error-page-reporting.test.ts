import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextPageContext } from 'next';
import CustomErrorPage from '~/pages/_error';

/**
 * 🔴 SEAM guard. Everything else about this feature is tested against `reportBoundaryError` in
 * isolation, which cannot see whether anything CALLS it — measured: deleting the
 * `reportBoundaryError(...)` line from `_error.tsx`, i.e. removing the entire feature, left the
 * rest of the suite green. These tests assert the WIRING: that the page reports, that it does so
 * only where the report can actually be delivered, and that it does not invent an HTTP status.
 */

type Ctx = Partial<NextPageContext>;
const getInitialProps = (ctx: Ctx) =>
  (
    CustomErrorPage as unknown as { getInitialProps: (c: Ctx) => Promise<{ statusCode?: number }> }
  ).getInitialProps(ctx);

const okFetch = () =>
  vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
    void args;
    return Promise.resolve(new Response(null, { status: 200 }));
  });

/** The report is gated on `typeof window !== 'undefined'`; this project's env is node. */
function asBrowser<T>(fn: () => T): T {
  const had = 'window' in globalThis;
  if (!had) (globalThis as Record<string, unknown>).window = {};
  try {
    return fn();
  } finally {
    if (!had) delete (globalThis as Record<string, unknown>).window;
  }
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe('_error.tsx reporting', () => {
  it('reports a caught client-side error', async () => {
    const f = okFetch();
    globalThis.fetch = f as unknown as typeof fetch;

    await asBrowser(() => getInitialProps({ err: new Error('client boom') as Ctx['err'] }));

    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/application-error');
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.message).toContain('error boundary: root');
    expect(body.message).toContain('client boom');
  });

  // 🔴 A relative URL has nothing to resolve against on the server, so reporting there would be a
  // rejected fetch per SSR error rather than a report. The gate must be on the ENVIRONMENT.
  it('does NOT report when there is no window (server render)', async () => {
    const f = okFetch();
    globalThis.fetch = f as unknown as typeof fetch;

    await getInitialProps({ err: new Error('ssr boom') as Ctx['err'] });

    expect(f).not.toHaveBeenCalled();
  });

  it('does not report when there is no error', async () => {
    const f = okFetch();
    globalThis.fetch = f as unknown as typeof fetch;

    await asBrowser(() => getInitialProps({}));

    expect(f).not.toHaveBeenCalled();
  });

  // 🔴 Leaving this UNDEFINED is what makes `next/error` render "Application error: a client-side
  // exception has occurred" rather than a bare "500 | Internal Server Error" that asserts a status
  // the request never had. Defaulting it to 500 is a silent user-visible regression.
  it('leaves statusCode undefined for a caught client render error', async () => {
    globalThis.fetch = okFetch() as unknown as typeof fetch;
    const props = await asBrowser(() =>
      getInitialProps({ err: new Error('client boom') as Ctx['err'] })
    );
    expect(props.statusCode).toBeUndefined();
  });

  it('passes through a real HTTP status when there is one', async () => {
    globalThis.fetch = okFetch() as unknown as typeof fetch;
    const props = await getInitialProps({ res: { statusCode: 503 } as Ctx['res'] });
    expect(props.statusCode).toBe(503);
  });
});
