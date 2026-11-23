import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the SignalR hub connection: the WebSocket is the process boundary.
type Deferred = { resolve: () => void; reject: (error: Error) => void };
const hub = vi.hoisted(() => {
  const state = {
    state: 'Disconnected' as string,
    invokes: [] as { method: string; topic: string; call: Deferred }[],
    reconnecting: [] as (() => void)[],
    reconnected: [] as (() => void)[],
    close: [] as (() => void)[],
    start: null as Deferred | null,
  };
  const connection = {
    get state() {
      return state.state;
    },
    on: () => undefined,
    invoke: (method: string, topic: string) =>
      new Promise<void>((resolve, reject) => {
        state.invokes.push({ method, topic, call: { resolve, reject } });
      }),
    onreconnecting: (fn: () => void) => state.reconnecting.push(fn),
    onreconnected: (fn: () => void) => state.reconnected.push(fn),
    onclose: (fn: () => void) => state.close.push(fn),
    start: () =>
      new Promise<void>((resolve, reject) => {
        state.start = { resolve, reject };
      }),
  };
  return { state, connection };
});
vi.mock('@microsoft/signalr', () => {
  class HubConnectionBuilder {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      return hub.connection;
    }
  }
  return { HubConnectionBuilder, HttpTransportType: { WebSockets: 1 } };
});
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/public', () => ({
  env: { PUBLIC_SIGNALS_ENDPOINT: 'https://signals.test' },
}));

const flush = () => new Promise((done) => setTimeout(done, 0));

let signals: typeof import('./signals');

beforeEach(async () => {
  vi.resetModules();
  Object.assign(hub.state, {
    state: 'Disconnected',
    invokes: [],
    reconnecting: [],
    reconnected: [],
    close: [],
    start: null,
  });
  signals = await import('./signals');
});

async function open() {
  signals.connectSignals();
  hub.state.state = 'Connected';
  hub.state.start!.resolve();
  await flush();
}

const answer = async (method: string, topic: string) => {
  for (const call of hub.state.invokes.filter((c) => c.method === method && c.topic === topic)) {
    call.call.resolve();
  }
  await flush();
};

describe('signalsAt', () => {
  it('counts a topic as subscribed only once the hub confirms it', async () => {
    const leave = signals.joinTopic('knights-queue:Knight');
    await open();

    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: true,
      subscribed: false,
    });
    await answer('subscribe', 'knights-queue:Knight');
    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: true,
      subscribed: true,
    });
    leave();
  });

  it('needs every topic asked about to be confirmed', async () => {
    signals.joinTopic('knights-queue:Knight');
    signals.joinTopic('knights-queue:Templar');
    await open();
    await answer('subscribe', 'knights-queue:Knight');

    expect(signals.signalsAt(['knights-queue:Knight', 'knights-queue:Templar']).subscribed).toBe(
      false
    );
    await answer('subscribe', 'knights-queue:Templar');
    expect(signals.signalsAt(['knights-queue:Knight', 'knights-queue:Templar']).subscribed).toBe(
      true
    );
  });

  it('forgets every confirmation while reconnecting, and counts them again as the hub re-confirms', async () => {
    signals.joinTopic('knights-queue:Knight');
    await open();
    await answer('subscribe', 'knights-queue:Knight');

    hub.state.state = 'Reconnecting';
    hub.state.reconnecting.forEach((fn) => fn());
    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: false,
      subscribed: false,
    });

    hub.state.state = 'Connected';
    hub.state.reconnected.forEach((fn) => fn());
    expect(signals.signalsAt(['knights-queue:Knight']).subscribed).toBe(false);
    await answer('subscribe', 'knights-queue:Knight');
    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: true,
      subscribed: true,
    });
  });

  it('forgets every confirmation when the connection closes', async () => {
    signals.joinTopic('knights-queue:Knight');
    await open();
    await answer('subscribe', 'knights-queue:Knight');

    hub.state.state = 'Disconnected';
    hub.state.close.forEach((fn) => fn());
    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: false,
      subscribed: false,
    });
  });

  it('drops a topic once it is left, and ignores a confirmation that arrives after leaving', async () => {
    const leave = signals.joinTopic('knights-queue:Knight');
    await open();
    await answer('subscribe', 'knights-queue:Knight');
    leave();
    expect(signals.signalsAt(['knights-queue:Knight']).subscribed).toBe(false);

    const leaveAgain = signals.joinTopic('knights-queue:Templar');
    leaveAgain();
    await answer('subscribe', 'knights-queue:Templar');
    expect(signals.signalsAt(['knights-queue:Templar']).subscribed).toBe(false);
  });

  it('does not count a subscription the hub refused', async () => {
    signals.joinTopic('knights-queue:Knight');
    await open();
    hub.state.invokes.find((c) => c.topic === 'knights-queue:Knight')!.call.reject(new Error('no'));
    await flush();
    expect(signals.signalsAt(['knights-queue:Knight']).subscribed).toBe(false);
  });

  it('reports not connected before the connection opens', () => {
    signals.joinTopic('knights-queue:Knight');
    expect(signals.signalsAt(['knights-queue:Knight'])).toEqual({
      connected: false,
      subscribed: false,
    });
  });
});
