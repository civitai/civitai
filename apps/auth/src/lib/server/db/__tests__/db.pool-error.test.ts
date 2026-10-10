import type pgModule from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: an 'error' emitted with no listener is an uncaught exception that exits the process. When
// a database connection drops, node-postgres emits 'error' on the client and, for an idle client, on the
// pool. Records the real Pool db.ts builds (pg connects lazily, so nothing dials out) and replays both.

const h = vi.hoisted(() => ({
  pools: [] as pgModule.Pool[],
  Client: undefined as undefined | typeof pgModule.Client,
  logAxiomError: vi.fn((_e: unknown, _extra?: Record<string, unknown>) => Promise.resolve()),
}));

vi.mock('pg', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof pgModule }>()).default;
  class RecordingPool extends actual.Pool {
    constructor(...args: ConstructorParameters<typeof actual.Pool>) {
      super(...args);
      h.pools.push(this);
    }
  }
  h.Client = actual.Client;
  const pg = { ...actual, Pool: RecordingPool };
  return { ...pg, default: pg };
});

vi.mock('../../axiom', () => ({ logAxiomError: h.logAxiomError }));

process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:1/test';

const dropped = () => new Error('Connection terminated unexpectedly');

describe('auth hub db pool', () => {
  let pool: pgModule.Pool;

  beforeAll(async () => {
    await import('../db');
    expect(h.pools).toHaveLength(1);
    pool = h.pools[0];
  });

  beforeEach(() => h.logAxiomError.mockClear());

  it('survives an idle-client error re-emitted on the pool', () => {
    expect(() => pool.emit('error', dropped())).not.toThrow();
  });

  it('survives a connection dropped while a client is checked out, and logs it', () => {
    // pg-pool emits 'connect' for each new client and detaches its own client 'error' listener while
    // the client is checked out — so this client carries only what db.ts attached.
    const Client = h.Client;
    if (!Client) throw new Error('pg mock did not run');
    const client = new Client();
    pool.emit('connect', client);

    const err = dropped();
    expect(() => client.emit('error', err)).not.toThrow();
    expect(h.logAxiomError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ event: expect.any(String) })
    );
  });

  it('survives a second error on the same checked-out client', () => {
    // A socket error is followed by the socket's 'end', which pg reports as a second 'error' on the same
    // client — so the listener must outlive the first one.
    const Client = h.Client;
    if (!Client) throw new Error('pg mock did not run');
    const client = new Client();
    pool.emit('connect', client);

    expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    expect(() => client.emit('error', dropped())).not.toThrow();
    expect(h.logAxiomError).toHaveBeenCalledTimes(2);
  });
});
