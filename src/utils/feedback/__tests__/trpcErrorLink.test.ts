import { observable } from '@trpc/server/observable';
import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readTrpcErrors,
  recordTrpcError,
  resetBrowserErrorLog,
} from '~/utils/feedback/browserErrorLog';
import { feedbackErrorLink } from '~/utils/feedback/trpcErrorLink';

const SECRET_INPUT = 'my-private-prompt-4f9c';

/** Runs one operation through the link, against a downstream that fails with `error`. */
function runFailingCall(path: string, error: unknown) {
  const link = feedbackErrorLink({} as never);
  let seen: unknown;
  link({
    op: {
      id: 1,
      type: 'mutation',
      path,
      input: { prompt: SECRET_INPUT },
      context: {},
      signal: null,
    } as never,
    next: () =>
      observable((observer) => {
        observer.error(error as never);
        return () => undefined;
      }) as never,
  }).subscribe({ error: (err) => (seen = err) });
  return seen;
}

const trpcError = (message: string, code = 'BAD_REQUEST', httpStatus = 400) =>
  Object.assign(new Error(message), { data: { code, httpStatus } });

beforeEach(() => {
  resetBrowserErrorLog();
  // The link records only in a browser; this suite runs in node.
  vi.stubGlobal('window', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('feedbackErrorLink', () => {
  it('records the path, code and status of a failed call and passes the error on', () => {
    const error = trpcError('Validation failed');
    const seen = runFailingCall('image.create', error);

    expect(seen).toBe(error);
    expect(readTrpcErrors()).toEqual([
      { path: 'image.create', code: 'BAD_REQUEST', httpStatus: 400, at: expect.any(String) },
    ]);
  });

  it('never stores the input, even when the error message quotes it back', () => {
    runFailingCall('image.create', trpcError(`prompt "${SECRET_INPUT}" was refused`));

    const stored = JSON.stringify(readTrpcErrors());
    // Positive control: the call WAS recorded, so the absence below is not an empty buffer.
    expect(stored).toContain('image.create');
    expect(stored).not.toContain(SECRET_INPUT);
  });

  it('records nothing outside a browser', () => {
    vi.unstubAllGlobals();
    runFailingCall('image.create', trpcError('boom'));
    expect(readTrpcErrors()).toEqual([]);
  });

  it('is installed in both tRPC clients', () => {
    // A source pin: the link's own tests construct it directly, so they would stay green with it
    // removed from the client link chains.
    const source = readFileSync('src/utils/trpc.ts', 'utf8');
    expect(source.match(/^\s+feedbackErrorLink,$/gm)).toHaveLength(2);
  });

  it('records a call whose error carries no tRPC data as UNKNOWN', () => {
    runFailingCall('user.getById', new Error('Failed to fetch'));
    expect(readTrpcErrors()).toEqual([
      { path: 'user.getById', code: 'UNKNOWN', at: expect.any(String) },
    ]);
  });
});

describe('recordTrpcError', () => {
  it('drops a path that is not a dotted procedure name', () => {
    recordTrpcError({ path: 'image.create?token=abc', code: 'BAD_REQUEST' });
    recordTrpcError({ path: 'x'.repeat(101), code: 'BAD_REQUEST' });
    recordTrpcError({ path: 'image.create', code: 'BAD_REQUEST' });
    expect(readTrpcErrors().map((entry) => entry.path)).toEqual(['image.create']);
  });

  it('replaces a code that is not SCREAMING_SNAKE, and drops an out-of-range status', () => {
    recordTrpcError({ path: 'a.b', code: 'free text from the server', httpStatus: 200 });
    recordTrpcError({ path: 'a.c', code: 'NOT_FOUND', httpStatus: 600 });
    recordTrpcError({ path: 'a.d', code: 'NOT_FOUND', httpStatus: 404.5 });
    recordTrpcError({ path: 'a.e', code: 'NOT_FOUND', httpStatus: 599 });
    expect(
      readTrpcErrors().map(({ path, code, httpStatus }) => ({ path, code, httpStatus }))
    ).toEqual([
      { path: 'a.b', code: 'UNKNOWN', httpStatus: undefined },
      { path: 'a.c', code: 'NOT_FOUND', httpStatus: undefined },
      { path: 'a.d', code: 'NOT_FOUND', httpStatus: undefined },
      { path: 'a.e', code: 'NOT_FOUND', httpStatus: 599 },
    ]);
  });

  it('keeps the last ten', () => {
    for (let i = 0; i < 12; i++) recordTrpcError({ path: `p.n${i}`, code: 'NOT_FOUND' });
    const paths = readTrpcErrors().map((entry) => entry.path);
    expect(paths).toHaveLength(10);
    expect(paths[0]).toBe('p.n2');
    expect(paths[9]).toBe('p.n11');
  });
});
