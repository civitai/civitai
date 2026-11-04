import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playerRow = vi.hoisted(() => ({ value: undefined as { userId: number } | undefined }));

const getRecapState = vi.hoisted(() => vi.fn());
const BADGES = { small: { Knight: 'k48' }, large: { Knight: 'k450' } };
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst: async () => playerRow.value }) }),
    }),
  },
}));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({ getRecapState }));
vi.mock('$lib/server/rank-badges', () => ({ rankBadgeUrls: async () => BADGES }));

const { load } = await import('./+layout.server');

const event = (user?: { username: string; id?: number }) =>
  ({ locals: { user }, depends: vi.fn() } as never);
const run = (user: unknown = { id: 7, username: 'ana' }) =>
  load({ locals: { user }, depends: vi.fn() } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  getRecapState.mockReset();
  getRecapState.mockResolvedValue({ optedOut: false, dismissedToday: false, hasHistory: true });
});

afterEach(() => {
  playerRow.value = undefined;
  delete process.env.CIVITAI_APP_URL;
  delete process.env.KNIGHTS_CONVERSION_ENABLED;
});

describe('layout load', () => {
  it('points "Back to Civitai" at the configured main app, without a trailing slash', async () => {
    process.env.CIVITAI_APP_URL = 'https://main.example/';
    expect(await load(event())).toMatchObject({ civitaiUrl: 'https://main.example' });
  });

  it('falls back to civitai.com', async () => {
    expect(await load(event())).toMatchObject({ civitaiUrl: 'https://civitai.com', player: null });
  });

  it('hands the menu the signed-in player', async () => {
    expect(await load(event({ username: 'Sir' }))).toMatchObject({ player: { username: 'Sir' } });
  });

  it('hands the page the player id that keys their sound setting', async () => {
    expect(await load(event({ username: 'Sir', id: 4 }))).toMatchObject({ userId: 4 });
    expect(await load(event())).toMatchObject({ userId: null });
  });

  it('offers "Convert gold" only while conversion is on', async () => {
    expect(await load(event())).toMatchObject({ conversionOpen: false });
    process.env.KNIGHTS_CONVERSION_ENABLED = 'true';
    expect(await load(event())).toMatchObject({ conversionOpen: true });
  });
  it('hands the header the Buzz rate, the rank badge images and the ladder rows from config', async () => {
    const data = await run();
    expect(data).toMatchObject({ goldPerBuzz: 1000, badges: BADGES });
    expect(data.ladder.map((row: { rank: string }) => row.rank)).toEqual([
      'Knight',
      'Templar',
      'Paladin',
    ]);
    expect(data.ladder[0]).toMatchObject({
      fromLevel: expect.any(Number),
      accuracyBar: expect.any(Number),
    });
  });

  it('tells the menu whether the viewer has a career to restart', async () => {
    expect(await load(event({ username: 'Sir', id: 4 }))).toMatchObject({ isPlayer: false });
    playerRow.value = { userId: 4 };
    expect(await load(event({ username: 'Sir', id: 4 }))).toMatchObject({ isPlayer: true });
    expect(await load(event())).toMatchObject({ isPlayer: false });
  });
});

const state = (over: Record<string, boolean> = {}) => ({
  optedOut: false,
  dismissedToday: false,
  hasHistory: true,
  ...over,
});

describe('layout load: the recap dot', () => {
  it('shows while there is a recap to see and it was not dismissed today', async () => {
    expect((await run()).recapUnseen).toBe(true);
    expect(getRecapState).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it.each([
    ['dismissed today', { dismissedToday: true }],
    ['opted out of the popup', { optedOut: true }],
    ['no earlier play day', { hasHistory: false }],
  ])('is off when %s', async (_name, over) => {
    getRecapState.mockResolvedValue(state(over));
    expect((await run()).recapUnseen).toBe(false);
  });

  it('is off, without a lookup, when nobody is signed in', async () => {
    expect((await run(null)).recapUnseen).toBe(false);
    expect(getRecapState).not.toHaveBeenCalled();
  });

  it('never breaks the page when the lookup fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getRecapState.mockRejectedValue(new Error('down'));
    expect((await run()).recapUnseen).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
