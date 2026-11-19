import { beforeEach, describe, expect, it, vi } from 'vitest';

const joinOrder = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/join.service', () => ({ joinOrder }));
const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
const seen = vi.hoisted(() => ({ store: null as null | import('$lib/server/seen').SeenStore }));
vi.mock('$lib/server/seen-runtime', async () => {
  const { memorySeenStore } = await import('$lib/server/seen');
  seen.store = memorySeenStore();
  return { seenStore: seen.store };
});

const { actions } = await import('./+page.server');

const submit = (fields: Record<string, string>, action: 'join' | 'consent' = 'join') => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions[action]({
    request: new Request('http://knights.test/', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(async () => {
  joinOrder.mockReset();
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1 });
  await seen.store!.set(7, {
    rank: 'Acolyte',
    level: 1,
    guide: false,
    whatsNew: false,
    consent: false,
  });
});

describe('join action', () => {
  it('swears the player in and sends them to play once the warning is accepted', async () => {
    joinOrder.mockResolvedValue({ joined: true });

    await expect(submit({ accepted: 'yes' })).rejects.toMatchObject({
      status: 303,
      location: '/play',
    });
    expect(joinOrder).toHaveBeenCalledWith(expect.anything(), 7);
    expect((await seen.store!.get(7))?.consent).toBe(true);
  });

  it('does not join without accepting the warning', async () => {
    expect(await submit({})).toMatchObject({ status: 400 });
    expect(joinOrder).not.toHaveBeenCalled();
  });

  it('tells the player when joining failed and logs the cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    joinOrder.mockRejectedValue(new Error('down'));

    expect(await submit({ accepted: 'yes' })).toMatchObject({
      status: 500,
      data: { message: expect.stringMatching(/try again/i) },
    });
    expect(log).toHaveBeenCalled();
  });
});

describe('consent action (a v1 player renewing the oath)', () => {
  it('records the accepted warning and sends the player to play', async () => {
    await expect(submit({ accepted: 'yes' }, 'consent')).rejects.toMatchObject({
      status: 303,
      location: '/play',
    });
    expect((await seen.store!.get(7))?.consent).toBe(true);
    expect(joinOrder).not.toHaveBeenCalled();
  });

  it('records nothing without accepting the warning', async () => {
    expect(await submit({}, 'consent')).toMatchObject({ status: 400 });
    expect((await seen.store!.get(7))?.consent).toBe(false);
  });
});
