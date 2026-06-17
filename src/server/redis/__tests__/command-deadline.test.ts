import { describe, it, expect, vi } from 'vitest';
import { withCommandDeadline } from '../command-deadline';

// withCommandDeadline is the bounded per-command guard for the CLUSTER (cache) redis
// client. On civitai-dp-prod a ~0.5% minority of cluster `_execute` promises never
// settle (inferred: cluster retry/topology-rediscovery orphans the outer promise),
// which both LEAKS the redis_commands_inflight gauge (its dec only fires when the
// wrapped promise settles) and PARKS the request handler ~125s. These pin the contract:
// a never-settling command must REJECT after the deadline so the wrapper settles. `ms`
// is passed explicitly so the test doesn't depend on env. Mirrors the sys-read-deadline
// tests (each fix in this area has regressed, so the contract is worth locking down).

const never = () => new Promise<never>(() => {}); // never settles — the leak case
const resolveAfter = <T>(ms: number, v: T) =>
  new Promise<T>((r) => setTimeout(() => r(v), ms));
const rejectAfter = (ms: number, e: Error) =>
  new Promise<never>((_, rej) => setTimeout(() => rej(e), ms));

describe('withCommandDeadline', () => {
  it('passes through a value that settles before the deadline (healthy command)', async () => {
    await expect(withCommandDeadline(resolveAfter(5, 'ok'), 100)).resolves.toBe('ok');
  });

  it('propagates a real rejection that arrives before the deadline (genuine redis error)', async () => {
    await expect(
      withCommandDeadline(rejectAfter(5, new Error('ClientClosedError')), 100)
    ).rejects.toThrow(/ClientClosedError/);
  });

  it('rejects with a timeout error when the command never settles (the leak case)', async () => {
    // This is the core property: the orphaned `_execute` promise that would otherwise
    // leak the inflight gauge + park the handler ~125s instead REJECTS, which lets the
    // instrumentation `.finally(done)` fire and the handler unpark.
    await expect(withCommandDeadline(never(), 20)).rejects.toThrow(
      /redis cluster command timed out after 20ms/
    );
  });

  it('settles the wrapped promise so a finally() (the gauge dec) always runs on timeout', async () => {
    // instrumentCommands relies on the wrapped promise SETTLING to dec the inflight
    // gauge via .finally(done). A never-settling command would leak the gauge forever;
    // the deadline guarantees the finally fires. Model that here directly.
    const done = vi.fn();
    await withCommandDeadline(never(), 20)
      .catch(() => {
        /* the timeout reject is expected */
      })
      .finally(done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled (ms <= 0): returns the same promise, never races', async () => {
    const p = resolveAfter(5, 'ok');
    // identical reference — no wrapper allocated, no timer armed
    expect(withCommandDeadline(p, 0)).toBe(p);
    // a command slower than any deadline still resolves (not timed out) when disabled
    await expect(withCommandDeadline(resolveAfter(30, 'late'), 0)).resolves.toBe('late');
  });

  it('does not emit an unhandledRejection when the orphaned command rejects after the deadline fired', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    // finally so a regressed assertion can't leak the listener into the shared worker.
    try {
      // deadline (10ms) wins the race; the underlying command rejects later (40ms) when
      // node-redis finally tears the dead socket down — that late rejection must be
      // reaped by Promise.race, not surface as unhandled.
      await expect(
        withCommandDeadline(rejectAfter(40, new Error('late socket death')), 10)
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 60)); // let the loser settle
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
