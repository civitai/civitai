import { describe, expect, it, vi } from 'vitest';
import {
  createCircuitBreaker,
  createSysReadGuard,
  SysReadUnavailableError,
  type BreakerState,
  type SysReadGuardConfig,
} from '../sys-read-breaker';

// The system-Redis read breaker behind withSysReadDeadline. Thresholds and cooldowns here are chosen
// away from the defaults (5 / 5000ms) and every clock reading sits well inside or well past a cooldown,
// never on its edge, so a mutant that hardcodes the default or shifts a boundary by one cannot pass.

const never = <T = never>() => new Promise<T>(() => undefined);
const fail = () => Promise.reject(new Error('ECONNRESET'));

const THRESHOLD = 3;
const COOLDOWN_MS = 1000;
const enabled: SysReadGuardConfig = {
  breakerEnabled: true,
  breaker: { threshold: THRESHOLD, cooldownMs: COOLDOWN_MS },
};

function makeGuard(config: SysReadGuardConfig = enabled) {
  const clock = { now: 10_000 };
  const breaker = createCircuitBreaker();
  const failures: string[] = [];
  const guard = createSysReadGuard({
    config: () => config,
    breaker,
    now: () => clock.now,
    onFailure: (reason) => failures.push(reason),
  });
  return { guard, breaker, clock, failures };
}

async function failTimes(guard: ReturnType<typeof makeGuard>['guard'], n: number) {
  for (let i = 0; i < n; i++) await expect(guard(fail, 1000)).rejects.toThrow('ECONNRESET');
}

describe('sys read breaker state machine', () => {
  it('stays closed below the threshold and opens on exactly the THRESHOLD-th consecutive failure', async () => {
    const { guard, breaker } = makeGuard();
    await failTimes(guard, THRESHOLD - 1);
    expect(breaker.state()).toBe('closed');
    await failTimes(guard, 1);
    expect(breaker.state()).toBe('open');
  });

  it('counts CONSECUTIVE failures: a success in between resets the count', async () => {
    const { guard, breaker } = makeGuard();
    await failTimes(guard, THRESHOLD - 1);
    await expect(guard(() => Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    await failTimes(guard, THRESHOLD - 1);
    expect(breaker.state()).toBe('closed');
  });

  it('a null reply is a success, not a failure', async () => {
    const { guard, breaker } = makeGuard();
    await failTimes(guard, THRESHOLD - 1);
    await expect(guard(() => Promise.resolve(null), 1000)).resolves.toBeNull();
    await failTimes(guard, THRESHOLD - 1);
    expect(breaker.state()).toBe('closed');
  });

  it('while open, a thunk is never invoked and the read rejects as breaker-open', async () => {
    const { guard, clock, failures } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 0.4; // well inside the cooldown
    const op = vi.fn(() => Promise.resolve('would have answered'));
    const err = await guard(op, 1000).catch((e: unknown) => e);
    expect(op).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(SysReadUnavailableError);
    expect((err as SysReadUnavailableError).reason).toBe('breaker-open');
    expect(failures.at(-1)).toBe('breaker-open');
  });

  it('while open, a promise-form read returns at once instead of waiting out its deadline', async () => {
    const { guard } = makeGuard();
    await failTimes(guard, THRESHOLD);
    const started = Date.now();
    // A 10s deadline on a command that never answers: only the open breaker can return this fast.
    await expect(guard(never(), 10_000)).rejects.toMatchObject({ reason: 'breaker-open' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('after the cooldown lets exactly one probe through; a successful probe closes the breaker', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5; // well past the cooldown

    let answer!: (v: string) => void;
    const probe = vi.fn(() => new Promise<string>((r) => (answer = r)));
    const probed = guard(probe, 1000);
    expect(breaker.state()).toBe('half-open');

    // A second read while the probe is in flight still fails fast without touching the client.
    const other = vi.fn(() => Promise.resolve('x'));
    await expect(guard(other, 1000)).rejects.toMatchObject({ reason: 'breaker-open' });
    expect(other).not.toHaveBeenCalled();

    answer('ok');
    await expect(probed).resolves.toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(breaker.state()).toBe('closed');
    await expect(guard(other, 1000)).resolves.toBe('x');
  });

  it('a failed probe re-opens the breaker for another full cooldown', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    await expect(guard(fail, 1000)).rejects.toThrow('ECONNRESET');
    expect(breaker.state()).toBe('open');

    clock.now += COOLDOWN_MS * 0.4;
    const op = vi.fn(() => Promise.resolve('x'));
    await expect(guard(op, 1000)).rejects.toMatchObject({ reason: 'breaker-open' });
    expect(op).not.toHaveBeenCalled();
  });

  it('a timed-out probe counts as a failure (the deadline releases a hung probe)', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    await expect(guard(() => never(), 20)).rejects.toMatchObject({ reason: 'timeout' });
    expect(breaker.state()).toBe('open');
  });

  it('a probe that never settles (deadline off) does not hold the breaker half-open past a cooldown', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    void guard(() => never(), 0); // the stuck probe
    expect(breaker.state()).toBe('half-open');

    clock.now += COOLDOWN_MS * 0.4;
    const early = vi.fn(() => Promise.resolve('x'));
    await expect(guard(early, 1000)).rejects.toMatchObject({ reason: 'breaker-open' });
    expect(early).not.toHaveBeenCalled();

    clock.now += COOLDOWN_MS * 1.5;
    const next = vi.fn(() => Promise.resolve('fresh'));
    await expect(guard(next, 1000)).resolves.toBe('fresh');
    expect(breaker.state()).toBe('closed');
  });

  it('timeouts trip the breaker the same as errors', async () => {
    const { guard, breaker } = makeGuard();
    for (let i = 0; i < THRESHOLD; i++) {
      await expect(guard(() => never(), 10)).rejects.toThrow(/timed out after 10ms/);
    }
    expect(breaker.state()).toBe('open');
  });

  it('reports transitions in order: open, half-open, closed', async () => {
    const seen: BreakerState[] = [];
    const breaker = createCircuitBreaker((to) => seen.push(to));
    const cfg = { threshold: THRESHOLD, cooldownMs: COOLDOWN_MS };
    for (let i = 0; i < THRESHOLD; i++) breaker.onFailure(cfg, 0);
    expect(breaker.allow(cfg, COOLDOWN_MS * 1.5)).toBe(true);
    breaker.onSuccess();
    expect(seen).toEqual(['open', 'half-open', 'closed']);
  });
});

describe('sys read guard deadline', () => {
  it('releases a hung command at the deadline with a "timed out" error', async () => {
    const { guard, failures } = makeGuard();
    const started = Date.now();
    await expect(guard(never(), 25)).rejects.toThrow('sysRedis read timed out after 25ms');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failures).toEqual(['timeout']);
  });

  it('passes a value through and turns a synchronous throw from a thunk into a rejection', async () => {
    const { guard } = makeGuard();
    await expect(guard(() => Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(
      guard(() => {
        throw new Error('sync');
      }, 1000)
    ).rejects.toThrow('sync');
  });

  it('does not emit an unhandledRejection for a promise-form command it short-circuited', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const { guard } = makeGuard();
      await failTimes(guard, THRESHOLD);
      const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20));
      await expect(guard(late, 1000)).rejects.toMatchObject({ reason: 'breaker-open' });
      await new Promise((r) => setTimeout(r, 50));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('dark by default', () => {
  it('with the breaker disabled, failures never stop a read reaching the client or waiting its deadline', async () => {
    const { guard, breaker } = makeGuard({ ...enabled, breakerEnabled: false });
    for (let i = 0; i < THRESHOLD * 3; i++) {
      await expect(guard(() => never(), 5)).rejects.toThrow(/timed out/);
    }
    expect(breaker.state()).toBe('closed');
    const op = vi.fn(() => Promise.resolve('reached'));
    await expect(guard(op, 1000)).resolves.toBe('reached');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('with the breaker disabled and the deadline off, hands back the caller’s own promise', () => {
    const { guard } = makeGuard({ ...enabled, breakerEnabled: false });
    const p = Promise.resolve('same');
    expect(guard(p, 0)).toBe(p);
  });
});
