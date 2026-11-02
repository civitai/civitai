import { beforeEach, describe, expect, it, vi } from 'vitest';

const restartCareer = vi.hoisted(() => vi.fn());
const forgetLegacyCounters = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/join.service', () => ({ joinOrder: vi.fn() }));
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
    request: new Request('http://knights.test/', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(() => {
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
