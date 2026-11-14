import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playerRow = vi.hoisted(() => ({ value: undefined as { userId: number } | undefined }));

const getRecapState = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const getPlayerStatus = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
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
vi.mock('$lib/server/daily/daily.service', () => ({ getRecapState, getDailyStatus }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/standing', () => ({ getStanding }));
const feedbackEnabled = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/feedback/enabled', () => ({ feedbackEnabled }));
const rankBadgeUrls = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/rank-badges', () => ({ rankBadgeUrls }));

const { load } = await import('./+layout.server');

// `url` is a getter that records a read: a load that touches it re-runs on every navigation.
const urlReads = vi.hoisted(() => ({ count: 0 }));
const eventFor = (user: unknown, depends = vi.fn()) =>
  ({
    locals: { user },
    depends,
    get url() {
      urlReads.count += 1;
      return new URL('http://knights.test/shop/inventory');
    },
  } as never);
const event = (user?: { username: string; id?: number }) => eventFor(user);
const run = (user: unknown = { id: 7, username: 'ana' }) =>
  load(eventFor(user)) as Promise<Record<string, any>>;

beforeEach(() => {
  rankBadgeUrls.mockReset();
  rankBadgeUrls.mockResolvedValue(BADGES);
  feedbackEnabled.mockReset();
  feedbackEnabled.mockResolvedValue(false);
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1 });
  getDailyStatus.mockReset();
  getDailyStatus.mockResolvedValue({ streak: 3, shields: 1, maxShields: 2 });
  urlReads.count = 0;
  getRecapState.mockReset();
  getRecapState.mockResolvedValue({ optedOut: false, dismissedToday: false, hasHistory: true });
});

afterEach(() => {
  playerRow.value = undefined;
  delete process.env.CIVITAI_APP_URL;
  delete process.env.KNIGHTS_CONVERSION_DISABLED;
  delete process.env.KNIGHTS_SHOP_DISABLED;
});

describe('layout load', () => {
  it('opens the feedback control only for a signed-in player the flag is on for', async () => {
    feedbackEnabled.mockResolvedValue(true);
    expect(await run()).toMatchObject({ feedbackOpen: true });
    expect(feedbackEnabled).toHaveBeenCalledWith({ id: 7, username: 'ana' });
    feedbackEnabled.mockResolvedValue(false);
    expect(await run()).toMatchObject({ feedbackOpen: false });
    feedbackEnabled.mockClear();
    expect(await load(event(undefined))).toMatchObject({ feedbackOpen: false });
    expect(feedbackEnabled).not.toHaveBeenCalled();
  });

  it('keeps the feedback control away from a muted player, whatever the flag says', async () => {
    feedbackEnabled.mockResolvedValue(true);
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await run()).toMatchObject({ feedbackOpen: false });
  });

  it('carries the header stats for a player, so a page that loads none still shows them', async () => {
    playerRow.value = { userId: 7 };
    expect(await run()).toMatchObject({
      headerStats: {
        status: { rank: 'Acolyte' },
        daily: { streak: 3 },
      },
    });
    expect(getDailyStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ playerId: 7, rank: 'Acolyte' })
    );
  });

  it('has no header stats for someone who has not joined, and survives a failed read', async () => {
    expect(await run()).toMatchObject({ headerStats: null });
    playerRow.value = { userId: 7 };
    getPlayerStatus.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toMatchObject({ headerStats: { status: null, daily: null } });
  });

  it('keeps the status when only the streak read fails, so the pills show without it', async () => {
    playerRow.value = { userId: 7 };
    getDailyStatus.mockRejectedValue(new Error('daily down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toMatchObject({
      headerStats: { status: { rank: 'Acolyte' }, daily: null },
    });
    expect(log).toHaveBeenCalled();
  });

  it('has no pills and reads no streak for a joined player whose status is missing', async () => {
    playerRow.value = { userId: 7 };
    getPlayerStatus.mockResolvedValue(null);
    expect(await run()).toMatchObject({ headerStats: { status: null, daily: null } });
    expect(getDailyStatus).not.toHaveBeenCalled();
  });

  it('does not depend on the URL, and re-runs only when the header is invalidated', async () => {
    const depends = vi.fn();
    await load(eventFor({ id: 7, username: 'ana' }, depends));
    expect(urlReads.count).toBe(0);
    expect(depends).toHaveBeenCalledWith('knights:header');
  });

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

  it('offers the shop unless its kill switch is on, whatever the Buzz switch says', async () => {
    expect(await load(event())).toMatchObject({ shopOpen: true });
    process.env.KNIGHTS_CONVERSION_DISABLED = 'true';
    expect(await load(event())).toMatchObject({ shopOpen: true });
    process.env.KNIGHTS_SHOP_DISABLED = 'true';
    expect(await load(event())).toMatchObject({ shopOpen: false });
  });
  it('hands the header the Buzz rate, the rank badge images and the ladder rows from config', async () => {
    const data = await run();
    expect(data).toMatchObject({ goldPerBuzz: 400, badges: BADGES });
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
  it('ignores the old popup opt-out: the dot says "not yet seen today", whatever that column holds', async () => {
    getRecapState.mockResolvedValue(state({ optedOut: true }));
    expect((await run()).recapUnseen).toBe(true);
  });

  it('shows while there is a recap to see and it was not dismissed today', async () => {
    expect((await run()).recapUnseen).toBe(true);
    expect(getRecapState).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it.each([
    ['dismissed today', { dismissedToday: true }],
    ['no earlier play day', { hasHistory: false }],
  ])('is off when %s', async (_name, over) => {
    getRecapState.mockResolvedValue(state(over));
    expect((await run()).recapUnseen).toBe(false);
  });

  it('reads no rank badges for a signed-out visitor, and hands the signed-in their badges', async () => {
    rankBadgeUrls.mockResolvedValue(BADGES);
    expect((await run(null)).badges).toEqual({ small: {}, large: {} });
    expect(rankBadgeUrls).not.toHaveBeenCalled();
    expect((await run()).badges).toBe(BADGES);
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
