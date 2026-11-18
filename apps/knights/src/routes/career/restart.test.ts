import { beforeEach, describe, expect, it, vi } from 'vitest';

const restartCareer = vi.hoisted(() => vi.fn());
const forgetLegacyCounters = vi.hoisted(() => vi.fn());
const playerRow = vi.hoisted(() => ({
  value: undefined as { exp: number; goldEarned: number; goldConverted: number } | undefined,
}));
const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst: async () => playerRow.value }) }),
    }),
  },
}));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/career/restart.service', () => ({ restartCareer }));
vi.mock('$lib/server/career/runtime', () => ({ forgetLegacyCounters }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));

const { GET, POST } = await import('./+server');

const submit = async (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await POST({
    request: new Request('http://knights.test/career', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  restartCareer.mockReset();
  forgetLegacyCounters.mockReset();
  forgetLegacyCounters.mockResolvedValue(undefined);
});

describe('restart', () => {
  it('restarts the career and sends the player back to the start', async () => {
    restartCareer.mockResolvedValue({ reset: true });

    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 200,
      body: { ok: true, to: '/play' },
    });
    expect(restartCareer).toHaveBeenCalledWith(expect.anything(), 7, expect.any(Date));
    expect(forgetLegacyCounters).toHaveBeenCalledWith(7);
  });

  it('does nothing without the confirmation', async () => {
    expect(await submit({})).toMatchObject({ status: 400, body: { ok: false } });
    expect(restartCareer).not.toHaveBeenCalled();
  });

  it('answers 400 to a body that is not a form, and restarts nothing', async () => {
    const response = await POST({
      request: new Request('http://knights.test/career', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"confirmed":',
      }),
      locals: { user: { id: 7 } },
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(restartCareer).not.toHaveBeenCalled();
  });

  it('tells the player when the restart failed and clears no counters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    restartCareer.mockRejectedValue(new Error('down'));

    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 500,
      body: { ok: false, message: expect.stringMatching(/try again/i) },
    });
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('still lands the player at the start when the original game counters cannot be cleared', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    restartCareer.mockResolvedValue({ reset: true });
    forgetLegacyCounters.mockRejectedValue(new Error('redis down'));

    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 200,
      body: { ok: true, to: '/play' },
    });
    expect(log).toHaveBeenCalled();
  });

  it('sends a user who has not joined to the home page', async () => {
    restartCareer.mockResolvedValue({ reset: false });

    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 200,
      body: { ok: true, to: '/home' },
    });
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
  });
});

describe('restart for a muted player', () => {
  it('refuses with a friendly 403 so a mute cannot be used to clear smites', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 403,
      body: { ok: false, message: expect.stringMatching(/muted/i) },
    });
    expect(restartCareer).not.toHaveBeenCalled();
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
  });
});

describe('restart losses', () => {
  const run = async () => (await GET({ locals: { user: { id: 9 } } } as never)).json();

  it('has none for a visitor with no player row', async () => {
    playerRow.value = undefined;
    expect(await run()).toEqual({ losses: null });
    expect(getPlayerStatus).not.toHaveBeenCalled();
  });

  it('tells a player what a restart would take, for the confirmation', async () => {
    playerRow.value = { exp: 1200, goldEarned: 20000, goldConverted: 15000 };
    getPlayerStatus.mockResolvedValue({ level: 7, goldEarned: 20000, goldPending: 2 });
    const { losses } = await run();
    expect(losses.map((loss: { title: string }) => loss.title)).toContain(
      'Your level and experience'
    );
    expect(losses[1].detail).toMatch(/Level 7/);
    // Converted gold is already out of the account, so only the unconverted part is lost.
    expect(losses[2].detail).toBe('5,000 unspent and 2 still pending.');
  });
});
