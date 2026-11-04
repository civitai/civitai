import { beforeEach, describe, expect, it, vi } from 'vitest';

const restartCareer = vi.hoisted(() => vi.fn());
const forgetLegacyCounters = vi.hoisted(() => vi.fn());
const playerRow = vi.hoisted(() => ({ value: undefined as { exp: number } | undefined }));
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
vi.mock('$lib/server/yesno/items', () => ({ judgesNeeded: vi.fn(async () => 3) }));
vi.mock('$lib/server/career/restart.service', () => ({ restartCareer }));
vi.mock('$lib/server/career/runtime', () => ({ forgetLegacyCounters }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));

const { actions } = await import('./+page.server');

const submit = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.restart({
    request: new Request('http://knights.test/rules', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(() => {
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  restartCareer.mockReset();
  forgetLegacyCounters.mockReset();
  forgetLegacyCounters.mockResolvedValue(undefined);
});

describe('restart action', () => {
  it('restarts the career and sends the player back to the start', async () => {
    restartCareer.mockResolvedValue({ reset: true });

    await expect(submit({ confirmed: 'yes' })).rejects.toMatchObject({
      status: 303,
      location: '/play',
    });
    expect(restartCareer).toHaveBeenCalledWith(expect.anything(), 7, expect.any(Date));
    expect(forgetLegacyCounters).toHaveBeenCalledWith(7);
  });

  it('does nothing without the confirmation', async () => {
    expect(await submit({})).toMatchObject({ status: 400, data: { restartFailed: true } });
    expect(restartCareer).not.toHaveBeenCalled();
  });

  it('tells the player when the restart failed and clears no counters', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    restartCareer.mockRejectedValue(new Error('down'));

    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 500,
      data: { restartFailed: true, message: expect.stringMatching(/try again/i) },
    });
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('still lands the player at the start when the original game counters cannot be cleared', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    restartCareer.mockResolvedValue({ reset: true });
    forgetLegacyCounters.mockRejectedValue(new Error('redis down'));

    await expect(submit({ confirmed: 'yes' })).rejects.toMatchObject({
      status: 303,
      location: '/play',
    });
    expect(log).toHaveBeenCalled();
  });

  it('sends a user who has not joined to the front page', async () => {
    restartCareer.mockResolvedValue({ reset: false });

    await expect(submit({ confirmed: 'yes' })).rejects.toMatchObject({
      status: 303,
      location: '/',
    });
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
  });
});

describe('restart action for a muted player', () => {
  it('refuses with a friendly 403 so a mute cannot be used to clear smites', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await submit({ confirmed: 'yes' })).toMatchObject({
      status: 403,
      data: { message: expect.stringMatching(/muted/i), restartFailed: true },
    });
    expect(restartCareer).not.toHaveBeenCalled();
    expect(forgetLegacyCounters).not.toHaveBeenCalled();
  });
});

describe('rules load', () => {
  const run = async () => {
    const { load } = await import('./+page.server');
    return (await load({ locals: { user: { id: 9 } } } as never)) as Record<string, any>;
  };

  it('is open to a visitor with no player row: the rules, and no career to restart', async () => {
    playerRow.value = undefined;
    const result = await run();
    expect(result.facts).toBeDefined();
    expect(result.career).toBeNull();
    expect(getPlayerStatus).not.toHaveBeenCalled();
  });

  it('gives a player what a restart would take, for the confirmation, without feeding the header', async () => {
    playerRow.value = { exp: 1200 };
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 7 });
    const result = await run();
    expect(result.career).toEqual({ status: { rank: 'Knight', level: 7 }, exp: 1200 });
    expect(result.status).toBeUndefined();
  });
});
