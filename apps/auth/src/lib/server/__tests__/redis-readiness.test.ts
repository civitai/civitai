import { describe, expect, it } from 'vitest';
import { createRedisReadiness, type RedisClientState } from '../redis-readiness';

const GRACE = 30_000;

function setup(initial: Record<string, RedisClientState | null>) {
  let t = 1_000_000;
  const clients = { ...initial };
  const readiness = createRedisReadiness({ clients: () => clients, graceMs: GRACE, now: () => t });
  return {
    clients,
    at(ms: number) {
      t = 1_000_000 + ms;
      return readiness.check();
    },
  };
}

const open = (): RedisClientState => ({ isOpen: true, isReady: true });
const closed = (): RedisClientState => ({ isOpen: false, isReady: false });

describe('createRedisReadiness', () => {
  it('stays ready through a closed client shorter than the grace period', () => {
    const r = setup({ cache: closed(), sys: open() });
    expect(r.at(0).ready).toBe(true);
    expect(r.at(GRACE - 1_000).ready).toBe(true);
  });

  it('goes not-ready once a client has been closed past the grace period, naming it', () => {
    const r = setup({ cache: closed(), sys: open() });
    r.at(0);
    expect(r.at(GRACE + 1_000)).toEqual({ ready: false, unusable: ['cache'] });
  });

  it('recovers on the first check after the client reopens', () => {
    const r = setup({ cache: closed() });
    r.at(0);
    expect(r.at(GRACE + 1_000).ready).toBe(false);
    r.clients.cache = open();
    expect(r.at(GRACE + 11_000).ready).toBe(true);
  });

  it('restarts the clock after a reopen, so separate blips never add up', () => {
    const r = setup({ cache: closed() });
    r.at(0);
    r.clients.cache = open();
    r.at(20_000);
    r.clients.cache = closed();
    expect(r.at(40_000).ready).toBe(true); // 40 s since the FIRST blip began, but only 0 s into this one
    expect(r.at(40_000 + GRACE - 1_000).ready).toBe(true);
    expect(r.at(40_000 + GRACE + 1_000).ready).toBe(false);
  });

  it('counts an open client that is not ready (a connect() that never finishes)', () => {
    const r = setup({ sys: { isOpen: true, isReady: false } });
    r.at(0);
    expect(r.at(GRACE + 1_000)).toEqual({ ready: false, unusable: ['sys'] });
  });

  it('ignores a client that was never built or is not configured', () => {
    const r = setup({ cache: null, sys: null });
    r.at(0);
    expect(r.at(GRACE + 1_000).ready).toBe(true);
  });
});
