import { describe, it, expect } from 'vitest';
import { withCommandDeadline } from '../deadline';

describe('withCommandDeadline', () => {
  it('returns the input promise unchanged when ms <= 0 (disabled)', async () => {
    const p = Promise.resolve('ok');
    expect(withCommandDeadline(p, 0)).toBe(p);
    expect(withCommandDeadline(p, -5)).toBe(p);
  });

  it('resolves with the underlying value when the command settles first', async () => {
    await expect(withCommandDeadline(Promise.resolve('value'), 1000)).resolves.toBe('value');
  });

  it('propagates the underlying rejection when the command rejects first', async () => {
    const err = new Error('boom');
    await expect(withCommandDeadline(Promise.reject(err), 1000)).rejects.toBe(err);
  });

  it('rejects with a timeout error when the command never settles', async () => {
    // A promise that never settles — the deadline must reject it.
    const never = new Promise<string>(() => undefined);
    await expect(withCommandDeadline(never, 20)).rejects.toThrow(/timed out after 20ms/);
  });

  it('does not leak a late rejection from the orphaned command (no unhandledRejection)', async () => {
    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Rejects AFTER the deadline already fired — Promise.race must reap it.
      const late = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 40));
      await expect(withCommandDeadline(late, 10)).rejects.toThrow(/timed out/);
      // Give the late rejection time to fire into the (already-settled) race.
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
