import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNamedMasterQuery,
  createNamedMasterSource,
  createSentinelStaleMasterGuard,
  type NamedMasterSource,
  type SentinelNode,
} from '../sentinel-reconnect';

const OLD: SentinelNode = { host: '10.0.0.1', port: 6379 };
const NEW: SentinelNode = { host: '10.0.0.2', port: 6379 };
const connErr = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
/** Let the guard's background query settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A guard on `source`; `masterReady` stands in for RedisSentinel's getMasterNode(). */
function guardOn(
  source: NamedMasterSource,
  extra: { enabled?: boolean; now?: () => number; masterReady?: () => boolean } = {}
) {
  return createSentinelStaleMasterGuard({
    enabled: extra.enabled ?? true,
    source,
    isMasterConnectionReady: extra.masterReady ?? (() => false),
    log: () => undefined,
    now: extra.now,
  });
}

function makeGuard(answer: () => SentinelNode | undefined | Promise<SentinelNode | undefined>) {
  let t = 1_000_000;
  const now = () => t;
  const query = vi.fn(async () => answer());
  const source = createNamedMasterSource(query, now);
  const state = { masterReady: false };
  const guard = guardOn(source, { now, masterReady: () => state.masterReady });
  return { guard, source, query, state, advance: (ms: number) => (t += ms) };
}

describe('createSentinelStaleMasterGuard', () => {
  it('keeps retrying, with the usual backoff, while the Sentinel names the dialled master', async () => {
    const { guard, advance } = makeGuard(() => OLD);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    const delays: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      delays.push(guard.reconnectStrategy(i, connErr()));
      await settle();
      advance(1500);
    }
    expect(delays.slice(0, 4)).toEqual([0, 100, 200, 300]);
    expect(delays.at(-1)).toBe(3000);
    expect(delays.every((d) => typeof d === 'number')).toBe(true);
  });

  it('gives up on the dialled address once the Sentinel names another master', async () => {
    const { guard } = makeGuard(() => NEW);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    // The first failure only starts the query: nothing is known yet, so it retries.
    expect(guard.reconnectStrategy(0, connErr())).toBe(0);
    await settle();
    const verdict = guard.reconnectStrategy(1, connErr());
    expect(verdict).toBeInstanceOf(Error);
    expect((verdict as Error).message).toBe(
      'gave up on 10.0.0.1:6379: the Sentinel names 10.0.0.2:6379 as master'
    );
  });

  it('never gives up once a connection of this discovery has been seen up, until the next discovery', async () => {
    // One Sentinel lagging behind a failover can name a stale master during a blip on the current
    // one. Giving up a connection that has reached its master could leave it closed for good.
    const { guard, state, advance } = makeGuard(() => NEW);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    state.masterReady = true; // a pool connection is up
    guard.reconnectStrategy(0, connErr());
    await settle();
    expect(guard.reconnectStrategy(1, connErr())).toBe(100);
    state.masterReady = false; // both down now, but this discovery was seen up: still retried
    advance(1500);
    expect(guard.reconnectStrategy(2, connErr())).toBe(200);
    await settle();
    // A new discovery opens fresh connections, which have reached nothing yet.
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    advance(1500);
    guard.reconnectStrategy(0, connErr()); // asks after the discovery: NEW
    await settle();
    expect(guard.reconnectStrategy(1, connErr())).toBeInstanceOf(Error);
  });

  it('a new discovery forgets the answer taken before it', async () => {
    const THIRD: SentinelNode = { host: '10.0.0.3', port: 6379 };
    let answer = NEW;
    const { guard, advance } = makeGuard(() => answer);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.reconnectStrategy(0, connErr());
    await settle(); // cached: the Sentinel names NEW
    expect(guard.reconnectStrategy(1, connErr())).toBeInstanceOf(Error);

    // The master moved again before the next discovery, which dials what the Sentinel names now.
    answer = THIRD;
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: THIRD });
    // The cached NEW predates this discovery: comparing against it would give up on THIRD.
    expect(guard.reconnectStrategy(0, connErr())).toBe(0);
    advance(1500);
    guard.reconnectStrategy(1, connErr()); // asks again: THIRD
    await settle();
    // A fresh answer naming the dialled master: keep retrying it.
    expect(guard.reconnectStrategy(2, connErr())).toBe(200);
  });

  it('only a MASTER_CHANGE moves the dialled address (a SENTINEL_CHANGE names a Sentinel)', async () => {
    const { guard } = makeGuard(() => OLD);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.onTopologyChange({ type: 'SENTINEL_CHANGE', node: { host: '10.0.0.9', port: 26379 } });
    guard.reconnectStrategy(0, connErr());
    await settle();
    expect(guard.reconnectStrategy(1, connErr())).toBe(100);
  });

  it('ignores an answer older than 10s', async () => {
    let answer: SentinelNode | undefined = NEW;
    const { guard, advance } = makeGuard(() => answer);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.reconnectStrategy(0, connErr());
    await settle(); // the answer NEW is cached
    answer = undefined; // and no Sentinel answers after that
    advance(10_001);
    expect(guard.reconnectStrategy(1, connErr())).toBe(100);
  });

  it("an answer's age counts from when it arrived, not when it was asked", async () => {
    // A slow query (Sentinels ahead of the answering one timing out) must not discard its answer.
    let release: (n: SentinelNode) => void = () => undefined;
    const { guard, advance } = makeGuard(() => new Promise<SentinelNode>((r) => (release = r)));
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.reconnectStrategy(0, connErr()); // asks
    advance(10_500);
    release(NEW);
    await settle();
    expect(guard.reconnectStrategy(1, connErr())).toBeInstanceOf(Error);
  });

  it('keeps retrying when no Sentinel answers or the query fails', async () => {
    for (const answer of [() => undefined, () => Promise.reject(new Error('down'))]) {
      const { guard, advance } = makeGuard(answer);
      guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
      for (let i = 0; i < 5; i++) {
        expect(typeof guard.reconnectStrategy(i, connErr())).toBe('number');
        await settle();
        advance(1500);
      }
    }
  });

  it('keeps retrying before any MASTER_CHANGE (nothing known about the dialled address)', async () => {
    const { guard } = makeGuard(() => NEW);
    guard.reconnectStrategy(0, connErr());
    await settle();
    expect(guard.reconnectStrategy(1, connErr())).toBe(100);
  });

  it('asks the Sentinel at most once a second, one query at a time', async () => {
    let release: (n: SentinelNode) => void = () => undefined;
    const { guard, query, advance } = makeGuard(
      () => new Promise<SentinelNode>((r) => (release = r))
    );
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    for (let i = 0; i < 10; i++) guard.reconnectStrategy(i, connErr()); // same instant
    expect(query).toHaveBeenCalledTimes(1);
    advance(1500);
    guard.reconnectStrategy(10, connErr()); // the first query is still running
    expect(query).toHaveBeenCalledTimes(1);
    release(OLD);
    await settle();
    advance(1500);
    guard.reconnectStrategy(11, connErr());
    expect(query).toHaveBeenCalledTimes(2);
    release(OLD);
    await settle();
    guard.reconnectStrategy(12, connErr()); // nothing in flight, same instant as the last ask
    expect(query).toHaveBeenCalledTimes(2);
    advance(500);
    guard.reconnectStrategy(13, connErr()); // still under a second since the last ask
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('an answer asked for before this discovery chose its master is not used, even when shared', async () => {
    // Two guards on one source, as the serving and Buffer-mode clients share it.
    let t = 1_000_000;
    const now = () => t;
    const source = createNamedMasterSource(async () => NEW, now);
    const a = guardOn(source, { now });
    const b = guardOn(source, { now });
    a.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    a.reconnectStrategy(0, connErr()); // asks: NEW
    await settle();
    expect(a.reconnectStrategy(1, connErr())).toBeInstanceOf(Error);
    // b's discovery chose OLD after that answer was asked for: it may not act on it.
    b.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    expect(b.reconnectStrategy(0, connErr())).toBe(0);
    t += 1500;
    b.reconnectStrategy(1, connErr()); // asks again: NEW
    await settle();
    expect(b.reconnectStrategy(2, connErr())).toBeInstanceOf(Error);
  });

  it('disabled: never gives up, even when the Sentinel names another master', async () => {
    const query = vi.fn(async () => NEW);
    const source = createNamedMasterSource(query);
    const guard = guardOn(source, { enabled: false });
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.reconnectStrategy(0, connErr());
    await settle();
    expect(guard.reconnectStrategy(50, connErr())).toBe(3000);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('createNamedMasterSource polling', () => {
  afterEach(() => vi.useRealTimers());

  it('sees a failover within a second, without waiting for the next failure', async () => {
    vi.useFakeTimers();
    let answer = OLD;
    const source = createNamedMasterSource(async () => answer);
    const guard = guardOn(source);
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    guard.reconnectStrategy(0, connErr()); // asks: OLD
    await vi.advanceTimersByTimeAsync(0);
    answer = NEW; // the Sentinel fails over
    await vi.advanceTimersByTimeAsync(1000); // the follow-up ask: NEW
    expect(guard.reconnectStrategy(1, connErr())).toBeInstanceOf(Error);
  });

  it('asks about once a second while failures continue, and stops 10s after the last one', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => OLD);
    const source = createNamedMasterSource(query);
    source.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    // The first ask, then one a second until 10s after the only failure.
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(query.mock.calls.length).toBeLessThanOrEqual(12);
    const asked = query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(asked);
  });
});

describe('a discovery whose connections came up without ever failing', () => {
  afterEach(() => vi.useRealTimers());

  it('is seen as established, so a later blip never gives its connections up', async () => {
    vi.useFakeTimers();
    let ready = false;
    const source = createNamedMasterSource(async () => NEW);
    const guard = guardOn(source, { masterReady: () => ready });
    guard.onTopologyChange({ type: 'MASTER_CHANGE', node: OLD });
    ready = true; // connected first time: the strategy is never called
    await vi.advanceTimersByTimeAsync(1000);
    ready = false; // later, both connections drop
    guard.reconnectStrategy(0, connErr()); // asks: NEW
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.reconnectStrategy(1, connErr())).toBe(100);
  });
});

describe('createNamedMasterQuery', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** A TCP server that accepts connections and never replies; resolves its port + open sockets. */
  async function silentServer() {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => undefined);
      s.resume(); // read (and discard) what the client sends, so its hang-up is seen
      s.on('close', () => sockets.delete(s));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, sockets };
  }

  /** Parse complete RESP arrays of bulk strings out of `buf`; returns the commands and the rest. */
  function parseCommands(buf: string): { commands: string[][]; rest: string } {
    const commands: string[][] = [];
    let i = 0;
    for (;;) {
      const start = i;
      if (buf[i] !== '*') break;
      const nl = buf.indexOf('\r\n', i);
      if (nl < 0) break;
      const n = Number(buf.slice(i + 1, nl));
      i = nl + 2;
      const args: string[] = [];
      let complete = true;
      for (let k = 0; k < n; k++) {
        const l = buf.indexOf('\r\n', i);
        if (l < 0) {
          complete = false;
          break;
        }
        const len = Number(buf.slice(i + 1, l));
        if (buf.length < l + 2 + len + 2) {
          complete = false;
          break;
        }
        args.push(buf.slice(l + 2, l + 2 + len));
        i = l + 2 + len + 2;
      }
      if (!complete) {
        i = start;
        break;
      }
      commands.push(args);
    }
    return { commands, rest: buf.slice(i) };
  }

  /**
   * A minimal RESP server. With `password` set it behaves like `requirepass`: AUTH with any other
   * password fails, and every other command (CLIENT SETINFO aside) fails with NOAUTH until this
   * connection has authenticated.
   */
  async function respServer(reply: (args: string[]) => string, password?: string) {
    const seen: string[][] = [];
    const server = net.createServer((sock) => {
      let buf = '';
      let authed = password === undefined;
      sock.on('error', () => undefined);
      sock.on('data', (d) => {
        const parsed = parseCommands(buf + d.toString());
        buf = parsed.rest;
        for (const args of parsed.commands) {
          seen.push(args);
          const cmd = args[0].toUpperCase();
          if (cmd === 'AUTH') {
            authed = password === undefined || args.at(-1) === password;
            sock.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n');
          } else if (!authed && cmd !== 'CLIENT') {
            sock.write('-NOAUTH Authentication required.\r\n');
          } else {
            sock.write(reply(args));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, seen };
  }

  const bulk = (v: string) => `$${v.length}\r\n${v}\r\n`;

  /** A Sentinel naming 127.0.0.1:`port`, and that node answering ROLE with `role`. */
  async function sentinelNaming(role: string, auth: { sentinel?: string; node?: string } = {}) {
    const node = await respServer(
      (args) => (args[0].toUpperCase() === 'ROLE' ? `*1\r\n${bulk(role)}` : '+OK\r\n'),
      auth.node
    );
    const sentinel = await respServer(
      (args) =>
        args[0].toUpperCase() === 'SENTINEL'
          ? `*2\r\n${bulk('127.0.0.1')}${bulk(String(node.port))}`
          : '+OK\r\n',
      auth.sentinel
    );
    return { node, sentinel };
  }

  it('authenticates to the Sentinel and to the named node with their own passwords', async () => {
    const { node, sentinel } = await sentinelNaming('master', {
      sentinel: 'sent-pw',
      node: 'node-pw',
    });
    const query = createNamedMasterQuery({
      sentinels: [{ host: '127.0.0.1', port: sentinel.port }],
      name: 'itmaster',
      password: 'sent-pw',
      nodePassword: 'node-pw',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toEqual({ host: '127.0.0.1', port: node.port });
    expect(node.seen.some((a) => a[0].toUpperCase() === 'AUTH' && a.at(-1) === 'node-pw')).toBe(
      true
    );
  });

  it('returns the named node when it answers as a master', async () => {
    const { node, sentinel } = await sentinelNaming('master');
    const query = createNamedMasterQuery({
      sentinels: [{ host: '127.0.0.1', port: sentinel.port }],
      name: 'itmaster',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toEqual({ host: '127.0.0.1', port: node.port });
    expect(
      sentinel.seen.some((a) => a.join(' ') === 'SENTINEL GET-MASTER-ADDR-BY-NAME itmaster')
    ).toBe(true);
  });

  it('asks the next Sentinel when one cannot be reached', async () => {
    const { node, sentinel } = await sentinelNaming('master');
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise((r) => closed.close(r)); // nothing listens there now
    const query = createNamedMasterQuery({
      sentinels: [
        { host: '127.0.0.1', port: deadPort },
        { host: '127.0.0.1', port: sentinel.port },
      ],
      name: 'itmaster',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toEqual({ host: '127.0.0.1', port: node.port });
  });

  it('asks the next Sentinel when one names no master (nil, e.g. just restarted)', async () => {
    const { node, sentinel } = await sentinelNaming('master');
    const unaware = await respServer((args) =>
      args[0].toUpperCase() === 'SENTINEL' ? '*-1\r\n' : '+OK\r\n'
    );
    const query = createNamedMasterQuery({
      sentinels: [
        { host: '127.0.0.1', port: unaware.port },
        { host: '127.0.0.1', port: sentinel.port },
      ],
      name: 'itmaster',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toEqual({ host: '127.0.0.1', port: node.port });
    expect(unaware.seen.some((a) => a[0].toUpperCase() === 'SENTINEL')).toBe(true);
  });

  it('ignores a named node that cannot be reached (a Sentinel naming a master that is gone)', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const sentinel = await respServer((args) =>
      args[0].toUpperCase() === 'SENTINEL'
        ? `*2\r\n${bulk('127.0.0.1')}${bulk(String(deadPort))}`
        : '+OK\r\n'
    );
    const query = createNamedMasterQuery({
      sentinels: [{ host: '127.0.0.1', port: sentinel.port }],
      name: 'itmaster',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toBeUndefined();
  });

  it('ignores a named node that is not a master (a Sentinel lagging behind a failover)', async () => {
    const { node, sentinel } = await sentinelNaming('slave');
    const query = createNamedMasterQuery({
      sentinels: [{ host: '127.0.0.1', port: sentinel.port }],
      name: 'itmaster',
      timeoutMs: 1000,
    });
    await expect(query()).resolves.toBeUndefined();
    expect(node.seen.some((a) => a[0].toUpperCase() === 'ROLE')).toBe(true); // it was asked
  });

  it('a Sentinel that accepts but never replies yields no answer within the bound, and is hung up on', async () => {
    const { port, sockets } = await silentServer();
    const query = createNamedMasterQuery({
      sentinels: [{ host: '127.0.0.1', port }],
      name: 'itmaster',
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(query()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets.size).toBe(0);
  });
});
