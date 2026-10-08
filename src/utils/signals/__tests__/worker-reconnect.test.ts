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
  reconnectingCallbacks: Callback[] = [];
  reconnectedCallbacks: Callback[] = [];
  start = vi.fn(async () => {
    hub.starts.push({ connection: this, at: Date.now() });
    this.state = 'Connecting';
    await Promise.resolve();
    if (hub.up) {
      this.state = 'Connected';
      if (hub.dropAfterMs !== null) {
        // A hub that completes the handshake and then closes the connection, refusing reconnection
        // (as a server-side `OnConnectedAsync` failure does): onclose with an error, no reconnect.
        setTimeout(() => {
          if (this.state !== 'Connected') return;
          this.state = 'Disconnected';
          this.closeCallbacks.forEach((cb) => cb(new Error('server closed the connection')));
        }, hub.dropAfterMs);
      }
      return;
    }
    this.state = 'Disconnected';
    throw new Error('hub unreachable');
  });
  stop = vi.fn(async () => {
    this.state = 'Disconnected';
    this.closeCallbacks.forEach((cb) => cb());
  });
  invoke = vi.fn(async () => undefined);
  send = vi.fn(async () => undefined);
  on = vi.fn();
  onclose(cb: Callback) {
    this.closeCallbacks.push(cb);
  }
  onreconnecting(cb: Callback) {
    this.reconnectingCallbacks.push(cb);
  }
  onreconnected(cb: Callback) {
    this.reconnectedCallbacks.push(cb);
  }
}

const hub = {
  up: false,
  connections: [] as FakeConnection[],
  reconnectArg: undefined as unknown,
  starts: [] as { connection: FakeConnection; at: number }[],
  /** When set, every connection the hub accepts is closed by the server this long after. */
  dropAfterMs: null as number | null,
  tabAnswersClosed: false,
};

vi.mock('@microsoft/signalr', async (importOriginal) => {
  const actual = await importOriginal<typeof SignalR>();
  class HubConnectionBuilder {
    withUrl() {
      return this;
    }
    configureLogging() {
      return this;
    }
    withAutomaticReconnect(arg: unknown) {
      hub.reconnectArg = arg;
      return this;
    }
    build() {
      const connection = new FakeConnection();
      hub.connections.push(connection);
      return connection;
    }
  }
  return { ...actual, HubConnectionBuilder };
});

type Port = {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let port: Port;

async function loadWorker() {
  port = {
    // Optionally answer 'closed' with connection:init, as every tab does (useSignalsWorker's
    // reconnectCount effect). Off by default: most tests send their inits explicitly.
    postMessage: vi.fn((message: { type?: string; state?: string }) => {
      if (
        hub.tabAnswersClosed &&
        message?.type === 'connection:state' &&
        message.state === 'closed'
      )
        void init(9);
    }),
  };
  // Without `SharedWorkerGlobalScope` the script treats `self` as its one port (the dedicated-Worker
  // fallback), which is what lets a test talk to it directly.
  vi.stubGlobal('self', port);
  await import('~/utils/signals/worker');
}

async function send(data: unknown) {
  await port.onmessage!({ data });
}

const init = (tokenFetchedAt = 1) =>
  send({ type: 'connection:init', token: 'token', userId: 1, tokenFetchedAt });

/** Every `start()` call across every connection the worker built, as offsets from `t0`. */
function startTimes(t0: number, connection?: FakeConnection) {
  return hub.starts.filter((s) => !connection || s.connection === connection).map((s) => s.at - t0);
}

function gaps(times: number[]) {
  return times.slice(1).map((t, i) => t - times[i]);
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
  hub.reconnectArg = undefined;
  hub.starts = [];
  hub.dropAfterMs = null;
  hub.tabAnswersClosed = false;
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

  it('resets the schedule after a successful connect', async () => {
    const t0 = await startOutage(1);
    await runFor(3 * 60_000);
    expect(startTimes(t0).length).toBeGreaterThan(4);

    hub.up = true;
    await runFor(3 * 60_000); // the next scheduled retry connects
    const connection = hub.connections.at(-1)!;
    expect(connection.state).toBe('Connected');
    await runFor(61_000); // stays up long enough to count as stable

    // The hub goes away again: a fresh outage starts from the 3s step, not from the cap.
    hub.up = false;
    await connection.stop(); // fires onclose → the worker drops the connection
    const t1 = Date.now();
    await init(3);
    await runFor(30_000);
    const fresh = startTimes(t1, hub.connections.at(-1)!);
    expect(fresh.slice(0, 3)).toEqual([0, 3_000, 9_000]);
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
});

describe('signals worker: SignalR automatic reconnect', () => {
  it('uses a jittered retry policy rather than a fixed delay array', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    await init();
    await runFor(61_000); // a stable connection, so no earlier failures offset the schedule
    const policy = hub.reconnectArg as SignalR.IRetryPolicy;
    expect(Array.isArray(policy)).toBe(false);
    const delay = (previousRetryCount: number, elapsedMilliseconds = 0) =>
      policy.nextRetryDelayInMilliseconds({
        previousRetryCount,
        elapsedMilliseconds,
        retryReason: new Error('x'),
      });

    expect([0, 1, 2, 6, 20].map((n) => delay(n))).toEqual([3_000, 6_000, 12_000, 180_000, 180_000]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // The first reconnect is no longer an instant, fleet-synchronised 0ms.
    expect(delay(0)).toBe(500);
    // Gives up after 5 minutes, handing over to the start() retry below.
    expect(delay(9, 5 * 60_000)).toBeNull();
  });

  it('after giving up, the start() retry continues at the reconnect cadence instead of restarting it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    await init();
    const connection = hub.connections[0];
    expect(connection.state).toBe('Connected');
    await runFor(61_000); // a stable connection: the backoff starts this outage from zero

    // The hub dies; SignalR walks the policy through 7 failed attempts, and the 8th call — past the
    // 5 minute limit — gives up and closes the connection.
    hub.up = false;
    const policy = hub.reconnectArg as SignalR.IRetryPolicy;
    connection.reconnectingCallbacks.forEach((cb) => cb(new Error('lost')));
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((n) =>
      policy.nextRetryDelayInMilliseconds({
        previousRetryCount: n,
        elapsedMilliseconds: n * 45_000,
        retryReason: new Error('lost'),
      })
    );
    expect(delays.at(-1)).toBeNull();
    connection.state = 'Disconnected';
    // Real SignalR passes NO error here: `_reconnect` ends with `_completeClose()`.
    connection.closeCallbacks.forEach((cb) => cb());

    // Every tab answers 'closed' with connection:init.
    const t1 = Date.now();
    await init(2);
    await init(3);
    await runFor(60_000);
    // Previously: an immediate start() per init. Now the first attempt waits its turn on the
    // schedule, 7 failures in → the 180s step.
    expect(hub.connections.at(-1)!.start).not.toHaveBeenCalled();
    await runFor(130_000);
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([180_000]);
  });

  it('debug:reconnect during an automatic reconnect does not inherit its failure count', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    await init();
    const connection = hub.connections[0];
    await runFor(61_000);
    hub.up = false;
    const policy = hub.reconnectArg as SignalR.IRetryPolicy;
    connection.reconnectingCallbacks.forEach((cb) => cb(new Error('lost')));
    for (const n of [0, 1, 2, 3])
      policy.nextRetryDelayInMilliseconds({
        previousRetryCount: n,
        elapsedMilliseconds: n * 10_000,
        retryReason: new Error('lost'),
      });

    // `stop()` mid-reconnect fires onclose too; that close must not carry the 4 failures back.
    await send({ type: 'debug:reconnect' });
    const t1 = Date.now();
    await init(2);
    await vi.advanceTimersByTimeAsync(0);
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

describe('signals worker: connections that drop before they are stable', () => {
  it('a hub that accepts and then closes every connection still backs off', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    hub.dropAfterMs = 1_000;
    hub.tabAnswersClosed = true;
    const t0 = Date.now();
    await init();
    await runFor(8 * 60_000);
    // Each cycle: 1s connected, then the next step of the schedule (3s, 6s, 12s, ...). Resetting on
    // every successful handshake instead reconnected the moment each close arrived.
    expect(gaps(startTimes(t0)).slice(0, 7)).toEqual([
      4_000, 7_000, 13_000, 25_000, 49_000, 97_000, 181_000,
    ]);
  });

  it("SignalR's automatic reconnect also escalates across short-lived connections", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    hub.up = true;
    await init();
    const connection = hub.connections[0];
    const policy = hub.reconnectArg as SignalR.IRetryPolicy;
    const firstDelayAfterDrop = () =>
      policy.nextRetryDelayInMilliseconds({
        previousRetryCount: 0,
        elapsedMilliseconds: 0,
        retryReason: new Error('lost'),
      });
    const reconnected = () => connection.reconnectedCallbacks.forEach((cb) => cb('id'));

    await runFor(10_000);
    expect(firstDelayAfterDrop()).toBe(6_000); // dropped after 10s: one failure already
    reconnected();
    await runFor(10_000);
    expect(firstDelayAfterDrop()).toBe(12_000); // and again
    reconnected();
    await runFor(61_000);
    expect(firstDelayAfterDrop()).toBe(3_000); // stable for a minute: back to the first step
  });

  it('debug:reconnect on a connection younger than a minute still bypasses the backoff', async () => {
    hub.up = true;
    await init();
    await runFor(10_000);
    // Dropping a not-yet-stable connection must not count against the forced reconnect.
    await send({ type: 'debug:reconnect' });
    const t1 = Date.now();
    await init(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(startTimes(t1, hub.connections.at(-1)!)).toEqual([0]);
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
