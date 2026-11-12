import { describe, expect, it, vi } from 'vitest';
import {
  createCircuitBreaker,
  createSysReadGuard,
  SysReadUnavailableError,
  type BreakerState,
  type SysReadGuardConfig,
} from '../sys-read-breaker';

// The system-Redis read breaker behind withSysReadBreaker, and the plain deadline behind
// withSysReadDeadline. Thresholds and cooldowns are chosen away from the defaults (5 / 5000ms) and every
// clock reading sits well inside or well past a cooldown, never on its edge, so a mutant that hardcodes
// the default or shifts a boundary by one cannot pass.

const never = <T = never>() => new Promise<T>(() => undefined);
const fail = () => Promise.reject(new Error('ECONNRESET'));
const answered = <T>(v: T) => Promise.resolve(v);

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
  const g = createSysReadGuard({
    config: () => config,
    breaker,
    now: () => clock.now,
    onFailure: (reason) => failures.push(reason),
  });
  return { guard: g.withBreaker, deadline: g.deadline, breaker, clock, failures };
}

type Guard = ReturnType<typeof makeGuard>['guard'];
async function failTimes(guard: Guard, n: number) {
  for (let i = 0; i < n; i++) await expect(guard(fail(), 1000)).rejects.toThrow('ECONNRESET');
}
const breakerOpen = { reason: 'breaker-open' };

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
    await expect(guard(answered('ok'), 1000)).resolves.toBe('ok');
    await failTimes(guard, THRESHOLD - 1);
    expect(breaker.state()).toBe('closed');
  });

  it('a null reply is a success, not a failure', async () => {
    const { guard, breaker } = makeGuard();
    await failTimes(guard, THRESHOLD - 1);
    await expect(guard(answered(null), 1000)).resolves.toBeNull();
    await failTimes(guard, THRESHOLD - 1);
    expect(breaker.state()).toBe('closed');
  });

  it('while open, a read the store WOULD answer is refused as breaker-open', async () => {
    const { guard, clock, failures } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 0.4; // well inside the cooldown
    const err = await guard(answered('would have answered'), 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SysReadUnavailableError);
    expect((err as SysReadUnavailableError).reason).toBe('breaker-open');
    expect(failures.at(-1)).toBe('breaker-open');
  });

  it('while open, a hung read returns at once instead of waiting out its deadline', async () => {
    const { guard } = makeGuard();
    await failTimes(guard, THRESHOLD);
    const started = Date.now();
    // A 10s deadline on a command that never answers: only the open breaker can return this fast.
    await expect(guard(never(), 10_000)).rejects.toMatchObject(breakerOpen);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('after the cooldown lets exactly one probe through; a successful probe closes the breaker', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5; // well past the cooldown

    let answer!: (v: string) => void;
    const probed = guard(new Promise<string>((r) => (answer = r)), 1000);
    expect(breaker.state()).toBe('half-open');

    // A second read while the probe is in flight still fails fast.
    await expect(guard(answered('x'), 1000)).rejects.toMatchObject(breakerOpen);

    answer('ok');
    await expect(probed).resolves.toBe('ok');
    expect(breaker.state()).toBe('closed');
    await expect(guard(answered('x'), 1000)).resolves.toBe('x');
  });

  it('a failed probe re-opens the breaker for another full cooldown', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    await expect(guard(fail(), 1000)).rejects.toThrow('ECONNRESET');
    expect(breaker.state()).toBe('open');

    clock.now += COOLDOWN_MS * 0.4;
    await expect(guard(answered('x'), 1000)).rejects.toMatchObject(breakerOpen);
  });

  it('a timed-out probe counts as a failure (the deadline releases a hung probe)', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    await expect(guard(never(), 20)).rejects.toMatchObject({ reason: 'timeout' });
    expect(breaker.state()).toBe('open');
  });

  it('a probe that never settles (deadline off) does not hold the breaker half-open past a cooldown', async () => {
    const { guard, breaker, clock } = makeGuard();
    await failTimes(guard, THRESHOLD);
    clock.now += COOLDOWN_MS * 1.5;
    void guard(never(), 0); // the stuck probe
    expect(breaker.state()).toBe('half-open');

    clock.now += COOLDOWN_MS * 0.4;
    await expect(guard(answered('x'), 1000)).rejects.toMatchObject(breakerOpen);

    clock.now += COOLDOWN_MS * 1.5;
    await expect(guard(answered('fresh'), 1000)).resolves.toBe('fresh');
    expect(breaker.state()).toBe('closed');
  });

  it('timeouts trip the breaker the same as errors', async () => {
    const { guard, breaker } = makeGuard();
    for (let i = 0; i < THRESHOLD; i++) {
      await expect(guard(never(), 10)).rejects.toThrow(/timed out after 10ms/);
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

  it('does not emit an unhandledRejection for a command it refused', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const { guard } = makeGuard();
      await failTimes(guard, THRESHOLD);
      const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20));
      await expect(guard(late, 1000)).rejects.toMatchObject(breakerOpen);
      await new Promise((r) => setTimeout(r, 50));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('plain deadline (withSysReadDeadline)', () => {
  it('releases a hung command at the deadline and reports a timeout fail-open', async () => {
    const { deadline, failures } = makeGuard();
    const started = Date.now();
    await expect(deadline(never(), 25)).rejects.toThrow('sysRedis read timed out after 25ms');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failures).toEqual(['timeout']);
  });

  it('reports a read error as an error fail-open', async () => {
    const { deadline, failures } = makeGuard();
    await expect(deadline(fail(), 1000)).rejects.toThrow('ECONNRESET');
    expect(failures).toEqual(['error']);
  });

  it('never consults an open breaker and never feeds it', async () => {
    const { guard, deadline, breaker } = makeGuard();
    for (let i = 0; i < THRESHOLD * 2; i++) {
      await expect(deadline(never(), 5)).rejects.toThrow(/timed out/);
    }
    expect(breaker.state()).toBe('closed');

    await failTimes(guard, THRESHOLD);
    expect(breaker.state()).toBe('open');
    await expect(deadline(answered('read'), 1000)).resolves.toBe('read');
  });

  it('with the deadline off, hands back the caller’s own promise', () => {
    const { deadline } = makeGuard();
    const p = answered('same');
    expect(deadline(p, 0)).toBe(p);
  });
});

describe('dark by default', () => {
  it('with the breaker disabled, the opt-in read is the plain deadline: failures never trip it', async () => {
    const { guard, breaker, failures } = makeGuard({ ...enabled, breakerEnabled: false });
    for (let i = 0; i < THRESHOLD * 3; i++) {
      await expect(guard(never(), 5)).rejects.toThrow(/timed out/);
    }
    expect(breaker.state()).toBe('closed');
    expect(failures).toEqual(Array(THRESHOLD * 3).fill('timeout'));
    await expect(guard(answered('reached'), 1000)).resolves.toBe('reached');
  });

  it('with the breaker disabled and the deadline off, hands back the caller’s own promise', () => {
    const { guard } = makeGuard({ ...enabled, breakerEnabled: false });
    const p = answered('same');
    expect(guard(p, 0)).toBe(p);
  });
});
