import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFliptClient } from '../client';
import type { FliptSnapshot, FliptSnapshotStore } from '../snapshot';

// The REAL SDK and wasm engine, against a real HTTP server for "Flipt up" and a closed port for
// "Flipt down". Only the snapshot store is in memory.

const SNAPSHOT_PATH = '/internal/v1/evaluation/snapshot/namespace/default';

// A boolean flag whose base value is ON, and one whose base value is OFF: a default-on flag is the
// case a cold pod gets wrong today, and the default-off one shows the seeded engine evaluates the
// stored state rather than answering `true` for everything.
const flag = (key: string, enabled: boolean) => ({
  key,
  name: '',
  description: '',
  enabled,
  type: 'BOOLEAN_FLAG_TYPE',
  rules: [],
  rollouts: [],
});
const snapshotData = {
  namespace: { key: 'default' },
  flags: [flag('default-on-flag', true), flag('default-off-flag', false)],
};

const servers: Server[] = [];
const clients: { getClientSync(): { close(): void } | null }[] = [];

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A URL nothing listens on: bind a port, then close it. */
async function downUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function memoryStore(initial: FliptSnapshot | null = null) {
  let stored = initial;
  const saves: FliptSnapshot[] = [];
  const store: FliptSnapshotStore = {
    load: async () => stored,
    save: async (snapshot) => {
      saves.push(snapshot);
      stored = snapshot;
    },
  };
  return { store, saves };
}

// Seeding is DARK by default (FLIPT_SNAPSHOT_MAX_AGE_MS unset = 0), so these tests opt in.
const ON = 24 * 60 * 60 * 1000;

function client(
  url: string,
  store: FliptSnapshotStore | undefined,
  logs: string[] = [],
  snapshotMaxAgeMs: number = ON
) {
  const flipt = createFliptClient({
    url,
    snapshotMaxAgeMs,
    clientToken: 'token',
    environment: 'test-env',
    localOverrides: {},
    log: (message) => logs.push(message),
    onInitError: () => {},
    snapshotStore: store,
  });
  clients.push(flipt);
  return flipt;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.getClientSync()?.close();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe('a cold process with Flipt down', () => {
  it('reads a default-on flag as ON from a seeded snapshot', async () => {
    const logs: string[] = [];
    const { store } = memoryStore({ savedAt: Date.now() - 60_000, data: snapshotData });
    const flipt = client(await downUrl(), store, logs);

    expect(await flipt.isEnabled('default-on-flag')).toBe(true);
    expect(await flipt.isEnabled('default-off-flag')).toBe(false);
    expect(flipt.isEnabledSync('default-on-flag')).toBe(true);
    expect(logs.some((l) => l.includes('evaluating from the snapshot saved'))).toBe(true);
  });

  it('with no snapshot, every flag still fails closed to false', async () => {
    const { store } = memoryStore(null);
    const flipt = client(await downUrl(), store);
    expect(await flipt.isEnabled('default-on-flag')).toBe(false);
  });

  // Invariant guard: base also answers false here (it never seeds at all). It pins the age bound.
  it('refuses a snapshot older than the age limit, and says so', async () => {
    const logs: string[] = [];
    const { store } = memoryStore({
      savedAt: Date.now() - 25 * 60 * 60 * 1000,
      data: snapshotData,
    });
    const flipt = client(await downUrl(), store, logs);

    expect(await flipt.isEnabled('default-on-flag')).toBe(false);
    expect(logs.some((l) => l.includes('over the 86400s limit'))).toBe(true);
  });
});

describe('the snapshot round trip between processes', () => {
  it('a healthy process stores what Flipt served, and a cold one with Flipt down evaluates it', async () => {
    let requests = 0;
    const liveUrl = await listen((req, res) => {
      requests++;
      if (req.url !== SNAPSHOT_PATH) return void res.writeHead(404).end('{}');
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end(JSON.stringify(snapshotData));
    });
    const { store, saves } = memoryStore(null);

    const healthy = client(liveUrl, store);
    expect(await healthy.isEnabled('default-on-flag')).toBe(true);
    expect(requests).toBeGreaterThan(0);
    expect(saves).toHaveLength(1);
    expect(saves[0].data).toEqual(snapshotData);
    expect(saves[0].etag).toBe('"v1"');

    const cold = client(await downUrl(), store);
    expect(await cold.isEnabled('default-on-flag')).toBe(true);
  });

  it('a seeded process switches to live state once Flipt answers', async () => {
    let up = false;
    const liveData = { namespace: { key: 'default' }, flags: [flag('default-on-flag', false)] };
    const url = await listen((_req, res) => {
      if (!up) return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(liveData));
    });
    const { store } = memoryStore({ savedAt: Date.now(), data: snapshotData });
    const flipt = createFliptClient({
      url,
      clientToken: 'token',
      environment: 'test-env',
      localOverrides: {},
      log: () => {},
      onInitError: () => {},
      snapshotStore: store,
      snapshotMaxAgeMs: ON,
      failureCooldownMs: 0,
      evalCacheTtlMs: 0,
    });
    clients.push(flipt);

    expect(await flipt.isEnabled('default-on-flag')).toBe(true); // from the snapshot
    up = true;
    await flipt.isEnabled('default-on-flag'); // starts the background retry
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await flipt.isEnabled('default-on-flag')).toBe(false); // live state
    // ...on the sync readers too, which read whichever client is current.
    expect(flipt.isEnabledSync('default-on-flag')).toBe(false);
  });
});

// A process that alone cannot reach Flipt, past its first attempt: it must follow newer snapshots
// saved by siblings.
describe('a seeded process while Flipt stays down', () => {
  const offData = { namespace: { key: 'default' }, flags: [flag('default-on-flag', false)] };

  function retryingClient(url: string, store: FliptSnapshotStore, logs: string[] = []) {
    const flipt = createFliptClient({
      url,
      clientToken: 'token',
      environment: 'test-env',
      localOverrides: {},
      log: (message) => logs.push(message),
      onInitError: () => {},
      snapshotStore: store,
      snapshotMaxAgeMs: ON,
      failureCooldownMs: 0,
      evalCacheTtlMs: 0,
    });
    clients.push(flipt);
    return flipt;
  }

  /** Trigger background retries until `check` holds, or give up after `ms`. */
  async function retryUntil(
    flipt: ReturnType<typeof createFliptClient>,
    check: () => boolean,
    ms = 2000
  ) {
    // performance.now, not Date.now: a test may pin Date.now.
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await flipt.ensureInitialized(); // starts a retry (no cooldown) without waiting on it
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('picks up a newer snapshot a healthy sibling saved since the seed', async () => {
    const { store } = memoryStore({ savedAt: Date.now() - 60_000, data: snapshotData });
    const flipt = retryingClient(await downUrl(), store);
    expect(await flipt.isEnabled('default-on-flag')).toBe(true); // seeded from the first snapshot

    // A sibling with live state saves a flip.
    await store.save({ savedAt: Date.now(), data: offData }, true);
    await retryUntil(flipt, () => flipt.isEnabledSync('default-on-flag') === false);

    expect(flipt.isEnabledSync('default-on-flag')).toBe(false);
    expect(await flipt.isEnabled('default-on-flag')).toBe(false);
  });

  it('keeps the seeded state when the store holds nothing newer', async () => {
    const seededAt = Date.now() - 60_000;
    const { store } = memoryStore({ savedAt: seededAt, data: snapshotData });
    const flipt = retryingClient(await downUrl(), store);
    expect(await flipt.isEnabled('default-on-flag')).toBe(true);

    // An OLDER snapshot appears (e.g. a lagging writer): it must not replace the seeded one.
    let loads = 0;
    store.load = async () => {
      loads++;
      return { savedAt: seededAt - 1_000, data: offData };
    };
    await retryUntil(flipt, () => loads >= 3);

    expect(loads).toBeGreaterThanOrEqual(3); // positive control: the retries did reload the store
    expect(flipt.isEnabledSync('default-on-flag')).toBe(true);
  });

  it('once seeded, switches to a newer snapshot even one past the age limit', async () => {
    const { store } = memoryStore({ savedAt: Date.now() - 60_000, data: snapshotData });
    const flipt = retryingClient(await downUrl(), store);
    expect(await flipt.isEnabled('default-on-flag')).toBe(true);

    // A long outage: the newest stored snapshot is itself over the limit, but newer than ours.
    const savedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(savedAt + ON + 60 * 60 * 1000);
    await store.save({ savedAt, data: offData }, true);
    await retryUntil(flipt, () => flipt.isEnabledSync('default-on-flag') === false);

    expect(flipt.isEnabledSync('default-on-flag')).toBe(false);
  });

  // The age limit admits the first seed only. A seeded snapshot is never dropped for age, or a
  // fleet-wide outage longer than the limit would turn every seeded process's flags off at once
  // while live processes keep theirs.
  it('keeps serving the seeded state after it passes the age limit', async () => {
    const seededAt = Date.now() - 60_000;
    const { store } = memoryStore({ savedAt: seededAt, data: snapshotData });
    const flipt = retryingClient(await downUrl(), store);
    expect(await flipt.isEnabled('default-on-flag')).toBe(true); // seeded, well inside the limit

    // A day and an hour later, Flipt still down, and the store holds nothing newer: the same
    // snapshot, now itself over the limit.
    let loads = 0;
    store.load = async () => {
      loads++;
      return { savedAt: seededAt, data: snapshotData };
    };
    vi.spyOn(Date, 'now').mockReturnValue(seededAt + ON + 60 * 60 * 1000);
    await retryUntil(flipt, () => loads >= 3);

    expect(loads).toBeGreaterThanOrEqual(3); // positive control: retries ran under the pinned clock
    expect(flipt.isEnabledSync('default-on-flag')).toBe(true);
    expect(await flipt.isEnabled('default-on-flag')).toBe(true);
  });
});

describe('dark by default (FLIPT_SNAPSHOT_MAX_AGE_MS unset)', () => {
  /** A client built from env tuning only: no snapshotMaxAgeMs override. */
  function defaultClient(url: string, store: FliptSnapshotStore) {
    delete process.env.FLIPT_SNAPSHOT_MAX_AGE_MS;
    const flipt = createFliptClient({
      url,
      clientToken: 'token',
      environment: 'test-env',
      localOverrides: {},
      log: () => {},
      onInitError: () => {},
      snapshotStore: store,
    });
    clients.push(flipt);
    return flipt;
  }

  it('does not seed: a cold process with Flipt down and a fresh snapshot stored still reads false', async () => {
    let loads = 0;
    const store: FliptSnapshotStore = {
      load: async () => {
        loads++;
        return { savedAt: Date.now(), data: snapshotData };
      },
      save: async () => {},
    };
    const flipt = defaultClient(await downUrl(), store);

    expect(await flipt.isEnabled('default-on-flag')).toBe(false);
    expect(loads).toBe(0);
  });

  it('does not write: a healthy process saves nothing to the store', async () => {
    const liveUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end(JSON.stringify(snapshotData));
    });
    const { store, saves } = memoryStore(null);
    const flipt = defaultClient(liveUrl, store);

    expect(await flipt.isEnabled('default-on-flag')).toBe(true); // positive control: live works
    expect(saves).toHaveLength(0);
  });
});
