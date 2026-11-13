import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFliptClient } from '../client';

// `getStateVersion` is what lets an app memoize flag evaluations until the flag state changes
// (feature-flags.service's version-keyed cache). The REAL SDK and wasm engine, against a real HTTP
// server whose served state and ETag each test controls; polls are driven by hand through the SDK's
// own `refresh()` (the interval poller is 60s, far beyond a test).

const SNAPSHOT_PATH = '/internal/v1/evaluation/snapshot/namespace/default';

const flag = (key: string, enabled: boolean) => ({
  key,
  name: '',
  description: '',
  enabled,
  type: 'BOOLEAN_FLAG_TYPE',
  rules: [],
  rollouts: [],
});
const state = (enabled: boolean) => ({
  namespace: { key: 'default' },
  flags: [flag('switch', enabled)],
});

const servers: Server[] = [];
const clients: { getClientSync(): { close(): void } | null }[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.getClientSync()?.close();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

/**
 * A Flipt stand-in. `served.etag === null` sends no ETag (every poll is a full body); otherwise a
 * matching If-None-Match gets a 304, as Flipt does.
 */
async function fliptServer(initial: { body: unknown; etag: string | null }) {
  const served = { ...initial };
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url !== SNAPSHOT_PATH) return void res.writeHead(404).end('{}');
    if (served.etag && req.headers['if-none-match'] === served.etag) {
      return void res.writeHead(304, { etag: served.etag }).end();
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (served.etag) headers.etag = served.etag;
    res.writeHead(200, headers);
    res.end(JSON.stringify(served.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, served, requests: () => requests };
}

function client(url: string) {
  const flipt = createFliptClient({
    url,
    clientToken: 'token',
    environment: 'test-env',
    localOverrides: {},
    log: () => {},
    onInitError: () => {},
    // The eval cache is not what these tests are about; off, so every read hits the engine.
    evalCacheTtlMs: 0,
  });
  clients.push(flipt);
  return flipt;
}

/** One poll, as the SDK's interval poller runs it. */
async function poll(flipt: ReturnType<typeof client>) {
  const sdk = flipt.getClientSync() as unknown as { refresh(): Promise<boolean> };
  await sdk.refresh();
}

/** Lets the version's deferred second move (a 0ms timer) run. */
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('getStateVersion', () => {
  it('moves when the first client appears, then holds while nothing changes', async () => {
    const flipt_ = await fliptServer({ body: state(true), etag: '"v1"' });
    const flipt = client(flipt_.url);

    const beforeInit = flipt.getStateVersion();
    await flipt.ensureInitialized();
    await nextMacrotask();
    const afterInit = flipt.getStateVersion();
    expect(afterInit).not.toBe(beforeInit);

    // Unchanged state: a 304 poll, and plain repeated reads, leave it alone.
    const requestsBefore = flipt_.requests();
    await poll(flipt);
    await nextMacrotask();
    expect(flipt_.requests()).toBeGreaterThan(requestsBefore); // POSITIVE CONTROL: the poll ran
    expect(flipt.getStateVersion()).toBe(afterInit);
    expect(flipt.getStateVersion()).toBe(afterInit);
  });

  it('moves when a poll brings a changed state, and the engine answers with the new state', async () => {
    const flipt_ = await fliptServer({ body: state(false), etag: '"v1"' });
    const flipt = client(flipt_.url);
    await flipt.ensureInitialized();
    await nextMacrotask();
    expect(flipt.isEnabledSync('switch')).toBe(false);
    const before = flipt.getStateVersion();

    flipt_.served.body = state(true);
    flipt_.served.etag = '"v2"';
    await poll(flipt);
    const afterBody = flipt.getStateVersion();
    expect(afterBody).not.toBe(before);
    expect(flipt.isEnabledSync('switch')).toBe(true);

    // The deferred second move: retires anything derived between reading the body and the SDK
    // applying it.
    await nextMacrotask();
    expect(flipt.getStateVersion()).not.toBe(afterBody);
  });

  it('without an ETag, a re-sent identical body does not move it and a different body does', async () => {
    const flipt_ = await fliptServer({ body: state(false), etag: null });
    const flipt = client(flipt_.url);
    await flipt.ensureInitialized();
    await nextMacrotask();
    const settled = flipt.getStateVersion();

    const requestsBefore = flipt_.requests();
    await poll(flipt);
    await nextMacrotask();
    expect(flipt_.requests()).toBeGreaterThan(requestsBefore);
    expect(flipt.getStateVersion()).toBe(settled);

    flipt_.served.body = state(true);
    await poll(flipt);
    await nextMacrotask();
    expect(flipt.getStateVersion()).not.toBe(settled);
    expect(flipt.isEnabledSync('switch')).toBe(true);
  });
});
