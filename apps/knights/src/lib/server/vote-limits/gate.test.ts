import { describe, expect, it, vi } from 'vitest';
import { VOTE_LIMITS, type VoteLimit } from '../queue/vote-rate';
import { fakeRedis } from './fake-redis';
import { createVoteGate, type GateClient } from './gate';

const MINUTE = 60_000;
const limitsOf = (perMinute: number, perHour = 600, perDay = 3000): VoteLimit[] => [
  { windowSeconds: 60, max: perMinute },
  { windowSeconds: 3600, max: perHour },
  { windowSeconds: 86400, max: perDay },
];

function setup(limits: VoteLimit[] = limitsOf(3)) {
  const redis = fakeRedis();
  const gate = createVoteGate({
    client: () => redis.client,
    limits: async () => limits,
    timeoutMs: 50,
  });
  const at = () => new Date(redis.clock.now);
  return { ...redis, gate, at };
}

describe('vote gate in-flight cap', () => {
  it('refuses a request over the cap as limited, not as an error', async () => {
    const { gate, at } = setup(limitsOf(1000));
    const held = [await gate.enter(7, at()), await gate.enter(7, at()), await gate.enter(7, at())];
    expect(held.every((entry) => entry.status === 'open')).toBe(true);

    const over = await gate.enter(7, at());
    expect(over.status).toBe('limited');
  });

  it('frees a slot when a request finishes, and keeps players apart', async () => {
    const { gate, at } = setup(limitsOf(1000));
    const held = [await gate.enter(7, at()), await gate.enter(7, at()), await gate.enter(7, at())];
    expect((await gate.enter(8, at())).status).toBe('open');

    if (held[0].status === 'open') await held[0].release();
    expect((await gate.enter(7, at())).status).toBe('open');
  });

  it('releases the slot when the guarded work throws', async () => {
    const { gate, at } = setup(limitsOf(1000));
    for (let i = 0; i < 10; i++) {
      await expect(
        gate.guard(7, at(), async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
    }
    expect(await gate.guard(7, at(), async () => 'done')).toBe('done');
  });

  it('lets a slot that was never released expire', async () => {
    const { gate, at, clock } = setup(limitsOf(1000));
    for (let i = 0; i < 3; i++) await gate.enter(7, at());
    expect((await gate.enter(7, at())).status).toBe('limited');
    clock.now += 60_000;
    expect((await gate.enter(7, at())).status).toBe('open');
  });
});

describe('vote gate windows', () => {
  it('trips the minute window into a fixed ten-minute cooldown', async () => {
    const { gate, at, clock } = setup(limitsOf(3));
    for (let i = 0; i < 3; i++) {
      expect(await gate.guard(7, at(), async () => 'ok')).toBe('ok');
    }

    const tripped = await gate.guard(7, at(), async () => 'ok');
    expect(tripped).toEqual({ status: 'limited', until: new Date(10 * MINUTE) });

    // Well after the minute window has rolled over, the cooldown still holds.
    clock.now += 5 * MINUTE;
    expect(await gate.guard(7, at(), async () => 'ok')).toEqual({
      status: 'limited',
      until: new Date(10 * MINUTE),
    });
    expect(await gate.cooldownUntil(7, at())).toEqual(new Date(10 * MINUTE));

    clock.now += 5 * MINUTE;
    expect(await gate.guard(7, at(), async () => 'ok')).toBe('ok');
    expect(await gate.cooldownUntil(7, at())).toBeNull();
  });

  it('does not run the guarded work while a cooldown holds', async () => {
    const { gate, at } = setup(limitsOf(1));
    await gate.guard(7, at(), async () => 'ok');
    const work = vi.fn(async () => 'ok');
    await gate.guard(7, at(), work);
    await gate.guard(7, at(), work);
    expect(work).not.toHaveBeenCalled();
  });

  it('cools down for an hour when the hour window trips and a day when the day window does', async () => {
    const hour = setup(limitsOf(1000, 2, 3000));
    for (let i = 0; i < 3; i++) await hour.gate.guard(7, hour.at(), async () => 'ok');
    expect(await hour.gate.cooldownUntil(7, hour.at())).toEqual(new Date(60 * MINUTE));

    const day = setup(limitsOf(1000, 600, 2));
    for (let i = 0; i < 3; i++) await day.gate.guard(7, day.at(), async () => 'ok');
    expect(await day.gate.cooldownUntil(7, day.at())).toEqual(new Date(24 * 60 * MINUTE));
  });

  it('keeps one player cooling down without touching another', async () => {
    const { gate, at } = setup(limitsOf(1));
    await gate.guard(7, at(), async () => 'ok');
    await gate.guard(7, at(), async () => 'ok');
    expect(await gate.guard(8, at(), async () => 'ok')).toBe('ok');
  });
});

describe('vote gate limits', () => {
  it('uses the limits it is given, so a changed config changes where it trips', async () => {
    let limits = limitsOf(2);
    const redis = fakeRedis();
    const gate = createVoteGate({
      client: () => redis.client,
      limits: async () => limits,
      timeoutMs: 50,
    });
    const at = () => new Date(redis.clock.now);
    await gate.guard(7, at(), async () => 'ok');
    limits = limitsOf(1);
    expect(await gate.guard(7, at(), async () => 'ok')).toMatchObject({ status: 'limited' });
  });
});

describe('vote gate when Redis is unavailable', () => {
  it('lets the vote through to the ledger check instead of failing it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down: GateClient = new Proxy({} as GateClient, {
      get: () => async () => {
        throw new Error('down');
      },
    });
    const gate = createVoteGate({
      client: () => down,
      limits: async () => VOTE_LIMITS,
      timeoutMs: 50,
    });
    const work = vi.fn(async () => 'ok');

    expect(await gate.guard(7, new Date(0), work)).toBe('ok');
    expect(work).toHaveBeenCalledOnce();
    expect(await gate.cooldownUntil(7, new Date(0))).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('does not wait on a Redis that never answers, once it is known to be down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const silent: GateClient = new Proxy({} as GateClient, {
      get: () => () => new Promise(() => undefined),
    });
    const gate = createVoteGate({
      client: () => silent,
      limits: async () => VOTE_LIMITS,
      timeoutMs: 20,
    });

    expect(await gate.guard(7, new Date(0), async () => 'ok')).toBe('ok');
    const started = Date.now();
    expect(await gate.guard(7, new Date(1), async () => 'ok')).toBe('ok');
    expect(Date.now() - started).toBeLessThan(15);
  });
});

describe('vote gate moderators', () => {
  it('is skipped by the caller, so a moderator never reaches Redis', async () => {
    const { gate, at, values } = setup(limitsOf(1));
    for (let i = 0; i < 5; i++) {
      expect(await gate.guard(7, at(), async () => 'ok', { moderator: true })).toBe('ok');
    }
    expect(values.size).toBe(0);
  });
});
