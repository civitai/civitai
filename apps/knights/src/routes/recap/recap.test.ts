import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const findRecap = vi.hoisted(() => vi.fn());
const getRecapState = vi.hoisted(() => vi.fn());
const dismissRecap = vi.hoisted(() => vi.fn());
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({
  getDailyStatus,
  findRecap,
  getRecapState,
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
  getDailyStatus.mockResolvedValue({ streak: 4, watchSize: 30, watchDone: false });
  getRecapState.mockResolvedValue({ optedOut: false, dismissedToday: true, hasHistory: true });
  findRecap.mockResolvedValue({ cast: 30 });
});

describe('GET /recap', () => {
  it('loads the recap on demand even after it was dismissed today, with the opt-out and the Watch', async () => {
    getRecapState.mockResolvedValue({ optedOut: true, dismissedToday: true, hasHistory: true });
    expect(await get()).toEqual({
      recap: { cast: 30 },
      optOut: true,
      watch: { streak: 4, size: 30, done: false },
    });
    expect(findRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('has no recap and no Watch for a player who has not joined', async () => {
    getPlayerStatus.mockResolvedValue(null);
    findRecap.mockResolvedValue(null);
    expect(await get()).toEqual({ recap: null, optOut: false, watch: null });
    expect(getDailyStatus).not.toHaveBeenCalled();
  });
});

describe('POST /recap', () => {
  it('dismisses today and stores the checkbox as the opt-out, ticked or not', async () => {
    expect((await post({ optOut: 'on' })).status).toBe(200);
    expect(dismissRecap).toHaveBeenLastCalledWith(expect.anything(), {
      playerId: 7,
      now: NOW,
      optOut: true,
    });
    await post();
    expect(dismissRecap).toHaveBeenLastCalledWith(expect.anything(), {
      playerId: 7,
      now: NOW,
      optOut: false,
    });
  });

  it('answers 500 when it could not be stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dismissRecap.mockRejectedValue(new Error('down'));
    expect((await post()).status).toBe(500);
    expect(log).toHaveBeenCalled();
  });
});
