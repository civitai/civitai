import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import snapshot from '~/server/services/__tests__/fixtures/flipt-store-scope.snapshot.json';
import {
  startFliptFixtureServer,
  type FliptFixtureServer,
} from '~/server/services/__tests__/fixtures/flipt-fixture-server';

/**
 * The app's own Flipt client (`~/server/flipt/client`, its production options) against a snapshot
 * without the key: the real wasm engine throws, and its `onEvalError` must log one record.
 */

let server: FliptFixtureServer;
let flipt: typeof FliptClient;
let previousClient: typeof globalThis.__civitaiFliptClient;

beforeAll(async () => {
  server = await startFliptFixtureServer(snapshot);
  setEnv({ FLIPT_URL: server.url, FLIPT_FETCHER_SECRET: 'test-token' });
  // The client is pinned on globalThis and the module may already be loaded in this worker, so
  // both are cleared to build one against the fixture server.
  previousClient = globalThis.__civitaiFliptClient;
  globalThis.__civitaiFliptClient = undefined;
  vi.resetModules();
  flipt = await import('~/server/flipt/client');
});

afterAll(async () => {
  flipt?.getFliptClientSync()?.close();
  globalThis.__civitaiFliptClient = previousClient;
  await server.close();
});

const evalErrorRecords = () =>
  (loggingMock.logToAxiom.mock.calls as unknown[][])
    .map(([data]) => data as Record<string, unknown>)
    .filter((data) => data?.name === 'flipt-eval-error');

describe('~/server/flipt/client evaluation errors', () => {
  it('log one record with the flag key, the message and the stack', async () => {
    await flipt.ensureFliptInitialized();
    // Instrument control: the engine is live, and a key it has evaluates without an error.
    expect(await flipt.readFliptBoolean('app-blocks-enabled')).toBe(false);
    const before = evalErrorRecords().length;

    expect(await flipt.isFlipt('fixture-no-such-flag')).toBe(false);

    const records = evalErrorRecords().slice(before);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: 'flipt-eval-error',
      type: 'error',
      flag: 'fixture-no-such-flag',
    });
    expect(records[0].message).toMatch(/fixture-no-such-flag/);
    expect(records[0].stack).toContain('\n');
  });
});
