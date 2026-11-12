import net from 'node:net';
import { createClient } from 'redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClusterCacheUnavailableError,
  createCircuitBreaker,
  createClusterCacheGuard,
  type ClusterCacheGuardConfig,
} from '~/server/redis/cluster-cache-guard';

/**
 * The cluster-cache fast-fail guard: a deadline on every guarded call, and a process breaker that
 * stops calling the client during an outage. Config is injected so nothing here depends on env.
 */

const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);
const never = () => new Promise<never>(() => undefined);

function guardWith(cfg: Partial<ClusterCacheGuardConfig> = {}, now?: () => number) {
  const config: ClusterCacheGuardConfig = {
    deadlineMs: 50,
    breakerEnabled: false,
    breaker: { threshold: 3, cooldownMs: 1000 },
    ...cfg,
  };
  const onFailure = vi.fn();
  const breaker = createCircuitBreaker();
  const guard = createClusterCacheGuard({ config: () => config, breaker, now, onFailure });
  return { guard, breaker, onFailure, config };
}

describe('deadline', () => {
  it('a rejecting call returns the fallback and reports reason=error', async () => {
    const { guard, onFailure } = guardWith();
    await expect(guard.readOr('t', () => Promise.reject(new Error('down')), 'miss')).resolves.toBe(
      'miss'
    );
    expect(onFailure).toHaveBeenCalledWith('t', 'error', expect.any(Error), 'read');
  });

  it('a call that never settles returns the fallback within 150ms (deadline 50ms)', async () => {
    const { guard, onFailure } = guardWith({ deadlineMs: 50 });
    const started = Date.now();
    await expect(within(guard.readOr('t', never, 'miss'), 2000)).resolves.toBe('miss');
    expect(Date.now() - started).toBeLessThan(150);
    expect(onFailure).toHaveBeenCalledWith(
      't',
      'timeout',
      expect.any(ClusterCacheUnavailableError),
      'read'
    );
  });

  it('call() throws a ClusterCacheUnavailableError carrying the reason', async () => {
    const { guard } = guardWith({ deadlineMs: 20 });
    await expect(guard.call('t', never)).rejects.toMatchObject({ reason: 'timeout', fn: 't' });
  });

  it('passes a value through and treats a miss (null) as success', async () => {
    const { guard, onFailure } = guardWith();
    await expect(guard.readOr('t', async () => null, 'fallback')).resolves.toBeNull();
    await expect(guard.readOr('t', async () => 'hit', 'fallback')).resolves.toBe('hit');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('deadlineMs 0 disables the bound: a slow call is still waited for', async () => {
    const { guard } = guardWith({ deadlineMs: 0 });
    const slow = () => new Promise<string>((r) => setTimeout(() => r('late'), 80));
    await expect(guard.readOr('t', slow, 'miss')).resolves.toBe('late');
  });

  it('a write that never settles resolves false within 150ms', async () => {
    const { guard } = guardWith({ deadlineMs: 50 });
    const started = Date.now();
    await expect(within(guard.writeBestEffort('w', never), 2000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe('breaker (enabled)', () => {
  it('opens after `threshold` consecutive failures: the next call never reaches the client', async () => {
    const { guard, breaker } = guardWith({ breakerEnabled: true });
    const op = vi.fn(() => Promise.reject(new Error('down')));
    for (let i = 0; i < 3; i++) await guard.readOr('t', op, null);
    expect(op).toHaveBeenCalledTimes(3);
    expect(breaker.state()).toBe('open');

    const started = Date.now();
    await expect(guard.readOr('t', op, 'miss')).resolves.toBe('miss');
    expect(Date.now() - started).toBeLessThan(20);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('timeouts count as failures', async () => {
    const { guard, breaker } = guardWith({ breakerEnabled: true, deadlineMs: 10 });
    for (let i = 0; i < 3; i++) await guard.readOr('t', never, null);
    expect(breaker.state()).toBe('open');
  });

  it('a success resets the consecutive count', async () => {
    const { guard, breaker } = guardWith({ breakerEnabled: true });
    const fail = () => Promise.reject(new Error('down'));
    await guard.readOr('t', fail, null);
    await guard.readOr('t', fail, null);
    await guard.readOr('t', async () => 'ok', null);
    await guard.readOr('t', fail, null);
    await guard.readOr('t', fail, null);
    expect(breaker.state()).toBe('closed');
  });

  it('after the cooldown lets ONE probe through; its success closes the breaker', async () => {
    let t = 0;
    const { guard, breaker } = guardWith({ breakerEnabled: true }, () => t);
    for (let i = 0; i < 3; i++) await guard.readOr('t', () => Promise.reject(new Error('x')), null);
    expect(breaker.state()).toBe('open');

    t = 999;
    const blocked = vi.fn(async () => 'v');
    await guard.readOr('t', blocked, 'miss');
    expect(blocked).not.toHaveBeenCalled();

    t = 1000;
    let release!: (v: string) => void;
    const probe = vi.fn(() => new Promise<string>((r) => (release = r)));
    const probing = guard.readOr('t', probe, 'miss');
    // While the probe is out, everyone else still fails fast.
    const other = vi.fn(async () => 'v');
    await expect(guard.readOr('t', other, 'miss')).resolves.toBe('miss');
    expect(other).not.toHaveBeenCalled();

    release('probe-ok');
    await expect(probing).resolves.toBe('probe-ok');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(breaker.state()).toBe('closed');
    await expect(guard.readOr('t', async () => 'after', 'miss')).resolves.toBe('after');
  });

  it('a failed probe re-opens the breaker for another cooldown', async () => {
    let t = 0;
    const { guard, breaker } = guardWith({ breakerEnabled: true }, () => t);
    const fail = vi.fn(() => Promise.reject(new Error('x')));
    for (let i = 0; i < 3; i++) await guard.readOr('t', fail, null);
    t = 1000;
    await guard.readOr('t', fail, null); // the probe
    expect(fail).toHaveBeenCalledTimes(4);
    expect(breaker.state()).toBe('open');
    t = 1500;
    await guard.readOr('t', fail, null);
    expect(fail).toHaveBeenCalledTimes(4);
  });

  it('reports a short-circuit as reason=breaker-open', async () => {
    const { guard, onFailure } = guardWith({ breakerEnabled: true });
    for (let i = 0; i < 3; i++) await guard.readOr('t', () => Promise.reject(new Error('x')), null);
    onFailure.mockClear();
    await guard.readOr('t', async () => 'v', null);
    expect(onFailure).toHaveBeenCalledWith(
      't',
      'breaker-open',
      expect.any(ClusterCacheUnavailableError),
      'read'
    );
  });
});

describe('breaker (disabled — the default)', () => {
  it('keeps calling the client however many calls fail', async () => {
    const { guard, breaker } = guardWith({ breakerEnabled: false });
    const op = vi.fn(() => Promise.reject(new Error('down')));
    for (let i = 0; i < 10; i++) await guard.readOr('t', op, null);
    expect(op).toHaveBeenCalledTimes(10);
    expect(breaker.state()).toBe('closed');
  });
});

/**
 * A real node-redis client against a server that ACCEPTS the command bytes and never replies — the
 * half-open shape where the command is already on the wire, so the client's own pre-send command
 * timeout cannot fire. The server records every command it received, which is the proof the GET
 * was actually written.
 */
describe('real client, command written and never answered', () => {
  let server: net.Server | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  afterEach(async () => {
    await client?.destroy();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    client = undefined;
    server = undefined;
  });

  /** Replies +OK to everything except GET, which it swallows. */
  async function blackHoleServer() {
    const received: string[][] = [];
    const s = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = parseCommand(buf);
          if (!parsed) break;
          buf = buf.subarray(parsed.consumed);
          received.push(parsed.args);
          if (parsed.args[0]?.toUpperCase() !== 'GET') socket.write('+OK\r\n');
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    server = s;
    return { port: (s.address() as net.AddressInfo).port, received };
  }

  it('the guard returns the fallback within 400ms (deadline 100ms); unguarded it is still pending at 600ms', async () => {
    const { port, received } = await blackHoleServer();
    client = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false } });
    client.on('error', () => undefined);
    await client.connect();

    // Positive control: the same GET, unguarded, is still pending after 600ms — the hang is real.
    const unguarded = await within(client.get('k-unguarded'), 600);
    expect(unguarded).toBe(HUNG);

    const { guard } = guardWith({ deadlineMs: 100 });
    const started = Date.now();
    const result = await within(
      guard.readOr('real', () => client!.get('k-guarded'), 'miss'),
      2000
    );
    expect(result).toBe('miss');
    expect(Date.now() - started).toBeLessThan(400);
    // Both GETs reached the server: the guard released a command that WAS written.
    expect(received.filter((a) => a[0]?.toUpperCase() === 'GET').map((a) => a[1])).toEqual([
      'k-unguarded',
      'k-guarded',
    ]);
  });
});

/** Parse one RESP array-of-bulk-strings command from the head of `buf`, or null if incomplete. */
function parseCommand(buf: Buffer): { args: string[]; consumed: number } | null {
  let pos = 0;
  const line = () => {
    const end = buf.indexOf('\r\n', pos);
    if (end === -1) return null;
    const s = buf.subarray(pos, end).toString();
    pos = end + 2;
    return s;
  };
  const head = line();
  if (head === null || head[0] !== '*') return null;
  const n = Number(head.slice(1));
  const args: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = line();
    if (len === null) return null;
    const size = Number(len.slice(1));
    if (buf.length < pos + size + 2) return null;
    args.push(buf.subarray(pos, pos + size).toString());
    pos += size + 2;
  }
  return { args, consumed: pos };
}
