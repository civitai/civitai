import { afterEach, describe, it, expect, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks';
import { withSysReadBreaker, withSysReadDeadline } from '../sys-read-deadline';

// withSysReadDeadline is the fail-open wall-clock guard for per-request sysRedis reads
// (the sys client has no socketTimeout, so a silent half-open would otherwise park a
// read until OS keepalive). These pin its contract; it's the 4th fix in this area and
// each prior fix regressed, so the contract is worth locking down. `ms` is passed
// explicitly so the test doesn't depend on env.

const never = () => new Promise<never>(() => {}); // never settles
const resolveAfter = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const rejectAfter = (ms: number, e: Error) =>
  new Promise<never>((_, rej) => setTimeout(() => rej(e), ms));

describe('withSysReadDeadline', () => {
  it('passes through a value that resolves before the deadline', async () => {
    await expect(withSysReadDeadline(resolveAfter(5, 'ok'), 100)).resolves.toBe('ok');
  });

  it('rejects with a timeout error when the read parks past the deadline', async () => {
    await expect(withSysReadDeadline(never(), 20)).rejects.toThrow(/timed out after 20ms/);
  });

  it('is a no-op when disabled (ms <= 0): returns the same promise, never races', async () => {
    const p = resolveAfter(5, 'ok');
    // identical reference — no wrapper allocated
    expect(withSysReadDeadline(p, 0)).toBe(p);
    // a read slower than any deadline still resolves (not timed out) when disabled
    await expect(withSysReadDeadline(resolveAfter(30, 'late'), 0)).resolves.toBe('late');
  });

  it('does not emit an unhandledRejection when the losing read rejects after the deadline fired', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    // finally so a regressed assertion can't leak the listener into the shared worker.
    try {
      // deadline (10ms) wins the race; the underlying read rejects later (40ms) — that
      // late rejection must be reaped by Promise.race, not surface as unhandled.
      await expect(
        withSysReadDeadline(rejectAfter(40, new Error('late socket death')), 10)
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 60)); // let the loser settle
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// The opt-in read breaker (withSysReadBreaker, sys-read-breaker.ts), driven through the env the way
// production turns it on. These import nothing from the breaker module, so they also run against code that
// has no breaker.
describe('withSysReadBreaker (env)', () => {
  const THRESHOLD = 3; // not the default 5
  const breakerOn = () =>
    envMock.set({
      REDIS_SYS_READ_BREAKER_ENABLED: true,
      REDIS_SYS_READ_BREAKER_THRESHOLD: THRESHOLD,
      REDIS_SYS_READ_BREAKER_COOLDOWN_MS: 60_000,
    });
  const trip = async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expect(withSysReadBreaker(never(), 5)).rejects.toThrow(/timed out/);
    }
  };
  afterEach(() => {
    globalThis.__civitaiSysReadBreaker?.reset();
    envMock.reset();
  });

  it('off by default: repeated timeouts never stop an opted-in read waiting for its answer', async () => {
    for (let i = 0; i < THRESHOLD * 3; i++) {
      await expect(withSysReadBreaker(never(), 5)).rejects.toThrow(/timed out/);
    }
    await expect(withSysReadBreaker(resolveAfter(5, 'reached'), 1000)).resolves.toBe('reached');
  });

  it('enabled: once tripped, a hung opted-in read fails open at once instead of waiting its deadline', async () => {
    breakerOn();
    await trip();
    const started = Date.now();
    // A 3s deadline on a command that never answers; only the tripped breaker returns this fast.
    const err = await withSysReadBreaker(never(), 3000).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(500);
    expect(err).toMatchObject({ reason: 'breaker-open' });
  }, 10_000);

  it('enabled: withSysReadDeadline never consults the tripped breaker and its timeouts never trip it', async () => {
    breakerOn();
    for (let i = 0; i < THRESHOLD * 2; i++) {
      await expect(withSysReadDeadline(never(), 5)).rejects.toThrow(/timed out/);
    }
    // Plain-deadline timeouts did not trip it: an opted-in read still gets its answer.
    await expect(withSysReadBreaker(resolveAfter(5, 'read'), 1000)).resolves.toBe('read');

    await trip();
    await expect(withSysReadBreaker(resolveAfter(5, 'x'), 1000)).rejects.toMatchObject({
      reason: 'breaker-open',
    });
    // …while a plain read is still answered, and a hung one still waits out its own deadline.
    await expect(withSysReadDeadline(resolveAfter(5, 'plain'), 1000)).resolves.toBe('plain');
    const started = Date.now();
    await expect(withSysReadDeadline(never(), 60)).rejects.toThrow(/timed out after 60ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
