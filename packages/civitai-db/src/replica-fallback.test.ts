import net from 'node:net';
import { Pool } from 'pg';
import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReplicaFallback,
  createReplicaFallbackCounter,
  runPrismaReadWithFallback,
  withPgReplicaFallback,
} from './replica-fallback';
import { startFakePgServer } from './test-support/fake-pg-server';

const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
const queryError = () =>
  Object.assign(new Error('relation "nope" does not exist'), { code: '42P01', severity: 'ERROR' });

function setup(opts: { maxConcurrent?: number; cooldownMs?: number } = {}) {
  const registry = new client.Registry();
  const counter = createReplicaFallbackCounter([registry]);
  let now = 1_000;
  const fallback = createReplicaFallback({
    label: 'test-read',
    maxConcurrent: opts.maxConcurrent ?? 2,
    cooldownMs: opts.cooldownMs ?? 5_000,
    counter,
    now: () => now,
  });
  const count = async (outcome: string) => {
    const metric = await counter.get();
    return metric.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  };
  return { fallback, count, advance: (ms: number) => (now += ms) };
}

describe('createReplicaFallback', () => {
  it('serves a read from the primary when the replica refuses the connection', async () => {
    const { fallback, count } = setup();
    const primary = vi.fn(async (done: () => void) => {
      done();
      return 'from-primary';
    });
    await expect(fallback.run(() => Promise.reject(refused()), primary)).resolves.toBe(
      'from-primary'
    );
    expect(primary).toHaveBeenCalledTimes(1);
    expect(await count('primary')).toBe(1);
  });

  it('never retries a query error on the primary', async () => {
    const { fallback, count } = setup();
    const primary = vi.fn();
    const err = queryError();
    await expect(fallback.run(() => Promise.reject(err), primary)).rejects.toBe(err);
    expect(primary).not.toHaveBeenCalled();
    expect(await count('primary')).toBe(0);
  });

  it('a pool-queue timeout alone (replica not marked down) is not a reason to fall back', async () => {
    const { fallback } = setup();
    const primary = vi.fn();
    const err = new Error('timeout exceeded when trying to connect');
    await expect(fallback.run(() => Promise.reject(err), primary)).rejects.toBe(err);
    expect(primary).not.toHaveBeenCalled();
  });

  it('caps borrowed primary resources: past the cap the replica error is rethrown at once', async () => {
    const { fallback, count } = setup({ maxConcurrent: 1 });
    let release!: () => void;
    const first = fallback.run(
      () => Promise.reject(refused()),
      async (done) => {
        release = done; // held: a checked-out primary client not yet released
        return 'held';
      }
    );
    await expect(first).resolves.toBe('held');
    expect(fallback.inFlight).toBe(1);

    const err = refused();
    const second = vi.fn();
    const start = Date.now();
    // Inside the cooldown the replica is skipped, so the error rethrown is the one that marked it down.
    await expect(fallback.run(() => Promise.reject(err), second)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(second).not.toHaveBeenCalled();
    expect(await count('capped')).toBe(1);

    release();
    expect(fallback.inFlight).toBe(0);
  });

  it('skips the replica for the cooldown after a connection failure, then probes it again', async () => {
    const { fallback, advance } = setup({ cooldownMs: 5_000 });
    const primary = async (done: () => void) => {
      done();
      return 'p';
    };
    await fallback.run(() => Promise.reject(refused()), primary);

    const replica = vi.fn(async () => 'r');
    await expect(fallback.run(replica, primary)).resolves.toBe('p');
    expect(replica).not.toHaveBeenCalled();

    advance(5_001);
    await expect(fallback.run(replica, primary)).resolves.toBe('r');
    expect(replica).toHaveBeenCalledTimes(1);
  });
});

async function closedPortUrl() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `postgresql://user:pass@127.0.0.1:${port}/testdb`;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

describe('withPgReplicaFallback on real pg pools', () => {
  it('replica down → the read pool hands out a primary client (wired)', async () => {
    const primaryServer = await startFakePgServer();
    cleanups.push(primaryServer.close);
    const primary = new Pool({
      connectionString: primaryServer.url,
      connectionTimeoutMillis: 2_000,
    });
    cleanups.push(() => primary.end());
    const read = new Pool({
      connectionString: await closedPortUrl(),
      connectionTimeoutMillis: 2_000,
    });
    cleanups.push(() => read.end());
    const { fallback } = setup();

    withPgReplicaFallback(read, () => primary, fallback);
    const conn = await read.connect();

    expect(primaryServer.sockets.size).toBe(1);
    expect(fallback.inFlight).toBe(1);
    conn.release();
    expect(fallback.inFlight).toBe(0);

    // The callback form, which pool.query uses internally.
    const viaCallback = await new Promise<unknown>((resolve, reject) =>
      read.connect((err, c) => (err ? reject(err) : (c!.release(), resolve(c))))
    );
    expect(viaCallback).toBeTruthy();
    expect(fallback.inFlight).toBe(0);
  });

  it('replica down and not wired (the flag-off state) → the replica error, primary untouched', async () => {
    const primaryServer = await startFakePgServer();
    cleanups.push(primaryServer.close);
    const read = new Pool({
      connectionString: await closedPortUrl(),
      connectionTimeoutMillis: 2_000,
    });
    cleanups.push(() => read.end());

    await expect(read.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(primaryServer.sockets.size).toBe(0);
  });
});

describe('runPrismaReadWithFallback', () => {
  const primaryWith = () => {
    const findMany = vi.fn(async (args: unknown) => [{ from: 'primary', args }]);
    const create = vi.fn();
    return { primary: { model: { findMany, create } }, findMany, create };
  };

  it('re-runs a model read on the primary delegate when the replica is unreachable', async () => {
    const { fallback } = setup();
    const { primary, findMany } = primaryWith();
    const args = { where: { id: 7 } };
    const p1001 = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
    await expect(
      runPrismaReadWithFallback(
        { model: 'Model', operation: 'findMany', args, query: () => Promise.reject(p1001) },
        primary,
        fallback
      )
    ).resolves.toEqual([{ from: 'primary', args }]);
    expect(findMany).toHaveBeenCalledWith(args);
    expect(fallback.inFlight).toBe(0);
  });

  it('never moves a query error, a write, or a raw query to the primary', async () => {
    const { fallback } = setup();
    const { primary, findMany, create } = primaryWith();
    const unique = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    await expect(
      runPrismaReadWithFallback(
        { model: 'Model', operation: 'findMany', args: {}, query: () => Promise.reject(unique) },
        primary,
        fallback
      )
    ).rejects.toBe(unique);
    const p1001 = Object.assign(new Error('down'), { code: 'P1001' });
    await expect(
      runPrismaReadWithFallback(
        { model: 'Model', operation: 'create', args: {}, query: () => Promise.reject(p1001) },
        primary,
        fallback
      )
    ).rejects.toBe(p1001);
    await expect(
      runPrismaReadWithFallback(
        { operation: '$queryRaw', args: {}, query: () => Promise.reject(p1001) },
        primary,
        fallback
      )
    ).rejects.toBe(p1001);
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
