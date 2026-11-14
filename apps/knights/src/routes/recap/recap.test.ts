import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const findRecap = vi.hoisted(() => vi.fn());
const dismissRecap = vi.hoisted(() => vi.fn());
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({
  findRecap,
  dismissRecap,
}));

const { GET, POST } = await import('./+server');

const locals = { user: { id: 7 } };
const get = async () => (await GET({ locals } as never)).json();
const post = (fields: Record<string, string> = {}) =>
  POST({ locals, request: { formData: async () => new URLSearchParams(fields) } } as never);

beforeEach(() => {
  vi.resetAllMocks();
  getPlayerStatus.mockResolvedValue({ rank: 'Knight' });
  findRecap.mockResolvedValue({ cast: 30 });
});

describe('GET /recap', () => {
  it('loads the recap on demand, even after it was dismissed today', async () => {
    expect(await get()).toEqual({ recap: { cast: 30 } });
    expect(findRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('has no recap for a player who has not joined', async () => {
    getPlayerStatus.mockResolvedValue(null);
    findRecap.mockResolvedValue(null);
    expect(await get()).toEqual({ recap: null });
  });
});

describe('POST /recap', () => {
  it('dismisses today and leaves the stored opt-out alone, whatever the form sends', async () => {
    expect((await post()).status).toBe(200);
    expect(dismissRecap).toHaveBeenLastCalledWith(expect.anything(), { playerId: 7, now: NOW });
    await post({ optOut: 'on' });
    expect(dismissRecap).toHaveBeenLastCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('answers 500 when it could not be stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dismissRecap.mockRejectedValue(new Error('down'));
    expect((await post()).status).toBe(500);
    expect(log).toHaveBeenCalled();
  });
});
