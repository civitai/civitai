import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptSdk from '@flipt-io/flipt-client-js';

// Fault injection on the SDK's `init`: a Flipt that answers in 6s against a 5s init timeout, one
// that rejects, and one that never answers. Fake timers, literal bounds.

const evaluateBoolean = vi.fn(() => ({ enabled: true }));
const close = vi.fn();
const makeClient = () => ({
  evaluateBoolean,
  evaluateVariant: vi.fn(),
  refresh: async () => {},
  close,
});
const init = vi.fn();

vi.mock('@flipt-io/flipt-client-js', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptSdk>()),
  FliptClient: { init: (...args: unknown[]) => init(...args) },
}));

import { createFliptClient } from '../client';

const config = {
  url: 'http://flipt.test',
  clientToken: 'token',
  environment: 'test-env',
  updateIntervalSeconds: 60,
  initTimeoutMs: 5000,
  failureCooldownMs: 30_000,
  evalCacheTtlMs: 0,
  evalCacheMaxEntries: 100,
  localOverrides: {},
  log: () => {},
  onInitError: () => {},
};

/** Resolves after `ms` of fake time. */
const after = <T>(ms: number, value: () => T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));

beforeEach(() => {
  vi.useFakeTimers();
  init.mockReset();
  close.mockReset();
  evaluateBoolean.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Flipt init that loses the timeout race', () => {
  it('closes the client that arrives after the timeout, so its poller does not run forever', async () => {
    init.mockImplementation(() => after(6000, makeClient));
    const flipt = createFliptClient(config);

    const answer = flipt.isEnabled('any-flag');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await answer).toBe(false);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(init).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not close a client that wins the race', async () => {
    init.mockImplementation(() => after(100, makeClient));
    const flipt = createFliptClient(config);

    const answer = flipt.isEnabled('any-flag');
    await vi.advanceTimersByTimeAsync(100);
    expect(await answer).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('Flipt init retries run in the background', () => {
  it('a request after the cooldown does not wait on the retry', async () => {
    init.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    // The retry never settles: a request that waited on it would wait the full 5s timeout.
    init.mockImplementationOnce(() => new Promise(() => undefined));
    const flipt = createFliptClient(config);

    expect(await flipt.isEnabled('any-flag')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);

    let settled = false;
    const answer = flipt.isEnabled('any-flag').then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await answer).toBe(false);
    // The retry did start; the request just did not wait for it.
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('ensureInitialized does not wait on a retry either', async () => {
    init.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    init.mockImplementationOnce(() => new Promise(() => undefined));
    const flipt = createFliptClient(config);

    await flipt.ensureInitialized();
    await vi.advanceTimersByTimeAsync(30_000);

    let settled = false;
    void flipt.ensureInitialized().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('a background retry that succeeds is used by the next request', async () => {
    init.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    init.mockImplementationOnce(() => after(200, makeClient));
    const flipt = createFliptClient(config);

    expect(await flipt.isEnabled('any-flag')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await flipt.isEnabled('any-flag')).toBe(false); // starts the retry, does not wait
    await vi.advanceTimersByTimeAsync(200);
    expect(await flipt.isEnabled('any-flag')).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('the first attempt on a cold process IS waited on, bounded by the init timeout', async () => {
    init.mockImplementation(() => after(300, makeClient));
    const flipt = createFliptClient(config);

    const answer = flipt.isEnabled('any-flag');
    await vi.advanceTimersByTimeAsync(300);
    expect(await answer).toBe(true);
  });
});
