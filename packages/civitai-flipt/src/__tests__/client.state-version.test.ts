import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFliptClient } from '../client';
import type { FliptSnapshot, FliptSnapshotStore } from '../snapshot';

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

// A seeded client (Flipt unreachable, state from a stored snapshot) is built from the store, not
// from a live fetch, so no snapshot body is ever noted for it: only the client-swap check in
// `getStateVersion` can see it appear or be replaced.
describe('getStateVersion across snapshot-seeded clients', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A URL nothing listens on: bind a port, then close it. */
  async function downUrl() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  function memoryStore(initial: FliptSnapshot) {
    let stored = initial;
    const store: FliptSnapshotStore = {
      load: async () => stored,
      save: async (snapshot) => {
        stored = snapshot;
      },
    };
    return store;
  }

  function seedingClient(url: string, store: FliptSnapshotStore) {
    const flipt = createFliptClient({
      url,
      clientToken: 'token',
      environment: 'test-env',
      localOverrides: {},
      log: () => {},
      onInitError: () => {},
      snapshotStore: store,
      snapshotMaxAgeMs: DAY,
      failureCooldownMs: 0,
      evalCacheTtlMs: 0,
    });
    clients.push(flipt);
    return flipt;
  }

  /** Start init attempts (no cooldown) until `check` holds, or give up after `ms`. */
  async function retryUntil(
    flipt: ReturnType<typeof seedingClient>,
    check: () => boolean,
    ms = 2000
  ) {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await flipt.ensureInitialized();
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // Fails with the swap check removed: Flipt is down, so no body is ever noted and nothing else
  // moves the version. Entries computed with no client (every flag at its fallback) would then
  // outlive the seeded state's arrival.
  it('moves when a seeded client appears', async () => {
    const store = memoryStore({ savedAt: Date.now() - 60_000, etag: '"v1"', data: state(true) });
    const flipt = seedingClient(await downUrl(), store);

    const before = flipt.getStateVersion();
    expect(await flipt.isEnabled('switch')).toBe(true); // POSITIVE CONTROL: seeded state answers
    expect(flipt.getStateVersion()).not.toBe(before);
  });

  // Fails with the swap check removed, for the same reason: a newer stored snapshot replaces the
  // seeded client while Flipt stays down.
  it('moves when a newer snapshot replaces the seeded client', async () => {
    const store = memoryStore({ savedAt: Date.now() - 60_000, etag: '"v1"', data: state(true) });
    const flipt = seedingClient(await downUrl(), store);
    expect(await flipt.isEnabled('switch')).toBe(true);
    const seededVersion = flipt.getStateVersion();

    await store.save({ savedAt: Date.now(), etag: '"v2"', data: state(false) }, true);
    await retryUntil(flipt, () => flipt.isEnabledSync('switch') === false);
    expect(flipt.isEnabledSync('switch')).toBe(false); // POSITIVE CONTROL: the replacement happened
    expect(flipt.getStateVersion()).not.toBe(seededVersion);
  });

  // The seeded → live switch with the live body carrying the SAME ETag as the seed. Pins that the
  // switch moves the version. Not a guard on the swap check alone: the live client's first body is
  // also noted (the seed never records a signature), which moves the version on its own.
  it('moves when the live client takes over, even with the same ETag as the seed', async () => {
    const served = state(true);
    let up = false;
    const server = createServer((req, res) => {
      if (!up) return void res.writeHead(503).end();
      if (req.url !== SNAPSHOT_PATH) return void res.writeHead(404).end('{}');
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end(JSON.stringify(served));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const store = memoryStore({ savedAt: Date.now() - 60_000, etag: '"v1"', data: served });
    const flipt = seedingClient(url, store);
    expect(await flipt.isEnabled('switch')).toBe(true); // seeded
    const seededClient = flipt.getClientSync();
    const seededVersion = flipt.getStateVersion();

    up = true;
    await retryUntil(flipt, () => flipt.getClientSync() !== seededClient);
    expect(flipt.getClientSync()).not.toBe(seededClient); // POSITIVE CONTROL: the live client took over
    expect(flipt.getStateVersion()).not.toBe(seededVersion);
  });
});
