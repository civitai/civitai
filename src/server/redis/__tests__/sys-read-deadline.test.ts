import { describe, it, expect, vi } from 'vitest';
import { withSysReadDeadline } from '../sys-read-deadline';

// withSysReadDeadline is the fail-open wall-clock guard for per-request sysRedis reads
// (the sys client has no socketTimeout, so a silent half-open would otherwise park a
// read until OS keepalive). These pin its contract; it's the 4th fix in this area and
// each prior fix regressed, so the contract is worth locking down. `ms` is passed
// explicitly so the test doesn't depend on env.

const never = () => new Promise<never>(() => {}); // never settles
const resolveAfter = <T>(ms: number, v: T) =>
  new Promise<T>((r) => setTimeout(() => r(v), ms));
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
    // deadline (10ms) wins the race; the underlying read rejects later (40ms) — that
    // late rejection must be reaped by Promise.race, not surface as unhandled.
    await expect(
      withSysReadDeadline(rejectAfter(40, new Error('late socket death')), 10)
    ).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 60)); // let the loser settle
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});
