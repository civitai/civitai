import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SignalR from '@microsoft/signalr';

// Drives the real signals worker script (`worker.ts`) with a fake SignalR connection, to pin how
// often a browser hits the hub while the hub is down. A fleet whose workers retried every 5s, in
// lockstep, multiplied hub connects ~200x during an outage.

vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_SIGNALS_ENDPOINT: 'http://signals.test' },
  formatErrors: () => [],
}));

type Callback = (...args: unknown[]) => void;

class FakeConnection {
  state = 'Disconnected';
  connectionId: string | null = null;
  closeCallbacks: Callback[] = [];
  constructor(private readonly accessTokenFactory: () => string) {}
  start = vi.fn(async () => {
    hub.starts.push({ connection: this, at: Date.now(), token: this.accessTokenFactory() });
    this.state = 'Connecting';
    await Promise.resolve();
    if (hub.up) {
      this.state = 'Connected';
      if (hub.dropAfterMs !== null) {
        // A hub that completes the handshake and then closes the connection (as a server-side
        // `OnConnectedAsync` failure does).
        setTimeout(() => this.drop(new Error('server closed the connection')), hub.dropAfterMs);
      }
      return;
    }
    // A failed start rejects; SignalR does not fire onclose for it.
    this.state = 'Disconnected';
    throw new Error('hub unreachable');
  });
  stop = vi.fn(async () => {
    if (this.state === 'Disconnected') return;
    this.state = 'Disconnected';
    // Real SignalR fires onclose (without an error) before stop() resolves.
    this.closeCallbacks.forEach((cb) => cb());
  });
  /** The connection is lost: with no automatic reconnect configured, SignalR fires onclose. */
  drop(error = new Error('connection lost')) {
    if (this.state !== 'Connected') return;
    this.state = 'Disconnected';
    this.closeCallbacks.forEach((cb) => cb(error));
  }
  invoke = vi.fn(async () => {
    if (hub.silent) return new Promise<never>(() => undefined);
    return undefined;
  });
  send = vi.fn(async () => undefined);
  on = vi.fn();
  onclose(cb: Callback) {
    this.closeCallbacks.push(cb);
  }
  // Present so an older worker script (which registers these) can still run against the fake.
  onreconnecting = vi.fn();
  onreconnected = vi.fn();
}

const hub = {
  up: false,
  connections: [] as FakeConnection[],
  automaticReconnectCalls: 0,
  starts: [] as { connection: FakeConnection; at: number; token: string }[],
  /** When set, every connection the hub accepts is closed by the server this long after. */
  dropAfterMs: null as number | null,
  /** The hub keeps the socket open but never answers an invoke. */
  silent: false,
};

vi.mock('@microsoft/signalr', async (importOriginal) => {
  const actual = await importOriginal<typeof SignalR>();
  class HubConnectionBuilder {
    private accessTokenFactory: () => string = () => '';
    withUrl(_url: string, options: { accessTokenFactory: () => string }) {
      this.accessTokenFactory = options.accessTokenFactory;
      return this;
    }
    configureLogging() {
      return this;
    }
    withAutomaticReconnect() {
      hub.automaticReconnectCalls += 1;
      return this;
    }
    build() {
      const connection = new FakeConnection(this.accessTokenFactory);
      hub.connections.push(connection);
      return connection;
    }
  }
  return { ...actual, HubConnectionBuilder };
});

type StateMessage = { type: 'connection:state'; state: string | null };

type Port = {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let port: Port;

async function loadWorker() {
  port = { postMessage: vi.fn() };
  // Without `SharedWorkerGlobalScope` the script treats `self` as its one port (the dedicated-Worker
  // fallback), which is what lets a test talk to it directly.
  vi.stubGlobal('self', port);
  await import('~/utils/signals/worker');
}

async function send(data: unknown) {
  await port.onmessage!({ data });
}

const init = (tokenFetchedAt = 1, token = 'token') =>
  send({ type: 'connection:init', token, userId: 1, tokenFetchedAt });

/** Every `start()` call across every connection the worker built, as offsets from `t0`. */
function startTimes(t0: number, connection?: FakeConnection) {
  return hub.starts.filter((s) => !connection || s.connection === connection).map((s) => s.at - t0);
}

/** `start()` calls on `connection` after `t0` (a dropped connection is restarted, not rebuilt). */
function startsSince(t0: number, connection: FakeConnection) {
  return startTimes(t0, connection).filter((t) => t > 0);
}

function gaps(times: number[]) {
  return times.slice(1).map((t, i) => t - times[i]);
}

/** The connection states the worker has broadcast to its port, in order. */
function statesSent() {
  return port.postMessage.mock.calls
    .map(([m]) => m as StateMessage)
    .filter((m) => m?.type === 'connection:state')
    .map((m) => m.state);
}

/** Advance in 100ms steps so every retry the worker schedules fires and settles. */
async function runFor(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await vi.advanceTimersByTimeAsync(100);
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  vi.resetModules();
  hub.up = false;
  hub.connections = [];
  hub.automaticReconnectCalls = 0;
  hub.starts = [];
  hub.dropAfterMs = null;
  hub.silent = false;
  await loadWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startOutage(random: number) {
  vi.spyOn(Math, 'random').mockReturnValue(random);
  const t0 = Date.now();
  await init();
  return t0;
}

/** Connect, and stay up long enough to count as stable. */
async function connectStably(random = 1) {
  vi.spyOn(Math, 'random').mockReturnValue(random);
  hub.up = true;
  await init();
  await runFor(61_000);
  const connection = hub.connections.at(-1)!;
  expect(connection.state).toBe('Connected');
  return connection;
}

describe('signals worker: hub start() retry', () => {
  it('backs off exponentially up to a 180s cap instead of retrying every 5s', async () => {
    const t0 = await startOutage(1);
    await runFor(15 * 60_000);
    const times = startTimes(t0);
    // random() = 1 takes the top of each window: 3s, doubling, capped at 180s.
    expect(gaps(times).slice(0, 9)).toEqual([
      3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 180_000, 180_000, 180_000,
    ]);
    expect(Math.max(...gaps(times))).toBe(180_000);
  });

  it('jitters each delay, so clients that failed together do not retry together', async () => {
    const t0 = await startOutage(0.5);
    await runFor(4 * 60_000);
    // Midpoint of [500ms, ceiling]: a client drawing 0.5 retries well before one drawing 1 (above).
    expect(gaps(startTimes(t0)).slice(0, 5)).toEqual([1_750, 3_250, 6_250, 12_250, 24_250]);
  });

  it('a connection:init arriving while a retry is pending does not add an attempt', async () => {
    const t0 = await startOutage(1);
    await runFor(1_000); // the first retry is pending, due at t0 + 3s
    // Another tab loading the page during the outage.
    await init(2);
    await runFor(500);
    expect(startTimes(t0)).toEqual([0]);
  });

  // Invariant guard (manual reconnect bypassed the 5s retry before this change too): a forced
  // reconnect must keep bypassing the now much longer backoff.
  it('debug:reconnect bypasses the backoff', async () => {
    const t0 = await startOutage(1);
    await runFor(4 * 60_000); // well into the schedule: next retry is minutes away
    const before = startTimes(t0).length;

    await send({ type: 'debug:reconnect' });
    const t1 = Date.now();
    await init(4); // the tab answers the resulting 'closed' with connection:init
    await vi.advanceTimersByTimeAsync(0);
    expect(startTimes(t0).length).toBe(before + 1);
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([0]);
  });

  it('a user switch during an outage connects the new user immediately', async () => {
    await startOutage(1);
    await runFor(4 * 60_000); // the old user's next retry is minutes away
    const t1 = Date.now();
    await send({ type: 'connection:init', token: 'other', userId: 2, tokenFetchedAt: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([0]);
  });
});

describe('signals worker: a lost connection', () => {
  it('uses no SignalR automatic reconnect: the backoff retry is the only mechanism', async () => {
    await connectStably();
    expect(hub.automaticReconnectCalls).toBe(0);
  });

  it("reports 'reconnecting' for the whole outage, then 'connected' — never 'closed'", async () => {
    const connection = await connectStably();
    port.postMessage.mockClear();
    hub.up = false;
    const t1 = Date.now();
    connection.drop();
    await runFor(20 * 60_000); // a long outage: many failed attempts
    expect(startsSince(t1, connection).length).toBeGreaterThan(5);
    expect(statesSent()).toEqual(['reconnecting']);

    hub.up = true;
    await runFor(4 * 60_000);
    expect(statesSent()).toEqual(['reconnecting', 'connected']);
  });

  it('retries the same connection with the token the worker holds — no tab involvement', async () => {
    const connection = await connectStably();
    await init(50, 'newer'); // another tab's newer token reached the worker while connected
    hub.up = false;
    const t1 = Date.now();
    connection.drop();
    await runFor(10_000);
    expect(hub.connections).toHaveLength(1);
    const retries = hub.starts.filter((s) => s.at > t1);
    expect(retries.map((s) => [s.at - t1, s.token])).toEqual([
      [3_000, 'newer'],
      [9_000, 'newer'],
    ]);
  });

  it('the first retry after a stable connection drops is jittered, not instant', async () => {
    const connection = await connectStably(0);
    hub.up = false;
    const t1 = Date.now();
    connection.drop();
    await runFor(1_200);
    // random() = 0 → the 500ms floor; random() = 1 gives 3s (above). Never a fleet-synchronised 0.
    expect(startsSince(t1, connection)).toEqual([500, 1_000]);
  });

  it('a stable connection resets the schedule: a later drop starts from the first step', async () => {
    const t0 = await startOutage(1);
    await runFor(3 * 60_000);
    expect(startTimes(t0).length).toBeGreaterThan(4);

    hub.up = true;
    await runFor(3 * 60_000); // the next scheduled retry connects
    const connection = hub.connections.at(-1)!;
    expect(connection.state).toBe('Connected');
    await runFor(61_000); // stays up long enough to count as stable

    hub.up = false;
    const t1 = Date.now();
    connection.drop();
    await runFor(30_000);
    expect(startsSince(t1, connection).slice(0, 3)).toEqual([3_000, 9_000, 21_000]);
  });

  it('a stale (zombie) connection is dropped and retried on the backoff', async () => {
    const connection = await connectStably();
    hub.silent = true; // socket open, nothing answers
    port.postMessage.mockClear();
    const t1 = Date.now();
    await runFor(5 * 60_000);
    expect(statesSent()).toContain('reconnecting');
    expect(statesSent()).not.toContain('closed');
    // Still up as far as `start()` is concerned, so the retry reconnects the same object.
    expect(startsSince(t1, connection).length).toBeGreaterThan(0);
  });
});

describe('signals worker: connections that drop before they are stable', () => {
  it('a hub that accepts and then closes every connection still backs off', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    hub.dropAfterMs = 1_000;
    const t0 = Date.now();
    await init();
    await runFor(8 * 60_000);
    // Each cycle: 1s connected, then the next step of the schedule (3s, 6s, 12s, ...). Resetting on
    // every successful handshake instead reconnected the moment each close arrived.
    expect(gaps(startTimes(t0)).slice(0, 7)).toEqual([
      4_000, 7_000, 13_000, 25_000, 49_000, 97_000, 181_000,
    ]);
  });

  it('debug:reconnect on a connection younger than a minute still bypasses the backoff', async () => {
    hub.up = true;
    await init();
    await runFor(10_000);
    await send({ type: 'debug:reconnect' });
    const t1 = Date.now();
    await init(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([0]);
  });

  it("a forced reconnect cancels the old connection's stability timer", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    await init();
    await runFor(10_000); // young connection: its 60s stability timer is pending
    hub.up = false;
    await send({ type: 'debug:reconnect' });
    const t1 = Date.now();
    await init(2);
    await runFor(3 * 60_000);
    // The old timer firing mid-outage would reset the backoff and cancel the pending retry.
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([
      0, 3_000, 9_000, 21_000, 45_000, 93_000,
    ]);
  });

  it('after a debug:reconnect, a later drop is still retried on the backoff', async () => {
    await connectStably();
    await send({ type: 'debug:reconnect' });
    await init(2); // the tab answers 'closed'; the rebuilt connection connects
    await runFor(61_000);
    const connection = hub.connections.at(-1)!;
    expect(connection.state).toBe('Connected');

    // The deliberate stop is over: an ordinary drop must not be ignored as if it were one.
    port.postMessage.mockClear();
    hub.up = false;
    const t1 = Date.now();
    connection.drop();
    await runFor(10_000);
    expect(statesSent()).toEqual(['reconnecting']);
    expect(startsSince(t1, connection)).toEqual([3_000, 9_000]);
  });

  it('debug:reconnect reports closed (so tabs re-init), not a drop', async () => {
    await connectStably();
    port.postMessage.mockClear();
    await send({ type: 'debug:reconnect' });
    expect(statesSent()).toEqual(['closed']);
  });

  it('a tab loading while a not-yet-stable connection is up schedules no attempt', async () => {
    await startOutage(1);
    await runFor(30_000); // a few failures
    hub.up = true;
    await runFor(60_000); // the next retry connects; not stable yet
    expect(hub.connections.at(-1)!.state).toBe('Connected');

    await init(2);
    const dumps: { connectRetry?: { failures: number; nextAttemptAt: number | null } }[] = [];
    port.postMessage.mockImplementation((message: { type?: string; data?: never }) => {
      if (message?.type === 'debug:dump') dumps.push(message.data!);
    });
    await send({ type: 'debug:dump' });
    expect(dumps[0].connectRetry?.failures).toBeGreaterThan(0);
    expect(dumps[0].connectRetry?.nextAttemptAt).toBeNull();
  });
});
