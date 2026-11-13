import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const findRecap = vi.hoisted(() => vi.fn());
const railFor = vi.hoisted(() => vi.fn());
const playerRow = vi.hoisted(() => ({ value: undefined as unknown }));
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst: async () => playerRow.value }) }),
    }),
  },
}));
vi.mock('$lib/server/join.service', () => ({ joinOrder: vi.fn() }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/daily/daily.service', () => ({ getDailyStatus, findRecap }));
vi.mock('$lib/server/rail-runtime', () => ({ railFor }));
const seenStore = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('$lib/server/seen-runtime', () => ({ seenStore }));

const { load, actions } = await import('./+page.server');
const run = () =>
  load({ locals: { user: { id: 7, username: 'Sir' } } } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  vi.resetAllMocks();
  playerRow.value = { rankType: 'Knight', exp: 10, startAt: new Date('2026-03-14T00:00:00Z') };
  getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 12 });
  getDailyStatus.mockResolvedValue({ streak: 12 });
  findRecap.mockResolvedValue({ cast: 30, confirmed: 18 });
  railFor.mockResolvedValue({ standing: { position: 14, total: 312 }, activity: 99 });
  seenStore.get.mockResolvedValue({ rank: 'Knight', level: 12, guide: true, whatsNew: true });
});

describe('home load', () => {
  it("carries yesterday's verdicts for the card, read at the injected clock", async () => {
    const page = await run();
    expect(page.recap).toEqual({ cast: 30, confirmed: 18 });
    expect(findRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('has no card when there is no play day to recap', async () => {
    findRecap.mockResolvedValue(null);
    expect((await run()).recap).toBeNull();
  });

  it('gives the fervor board position beside the stats', async () => {
    expect((await run()).fervorPosition).toBe(14);
    railFor.mockResolvedValue({ standing: null, activity: null });
    expect((await run()).fervorPosition).toBeNull();
  });

  it('still renders the page when the recap or the rail read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    findRecap.mockRejectedValue(new Error('down'));
    railFor.mockRejectedValue(new Error('down'));
    const page = await run();
    expect(page).toMatchObject({
      status: { rank: 'Knight' },
      daily: { streak: 12 },
      recap: null,
      fervorPosition: null,
    });
    vi.restoreAllMocks();
  });

  it("reads nothing of a player's days for someone who has not joined", async () => {
    playerRow.value = undefined;
    const page = await run();
    expect(page).toMatchObject({
      player: null,
      status: null,
      daily: null,
      recap: null,
      fervorPosition: null,
    });
    expect(findRecap).not.toHaveBeenCalled();
    expect(railFor).not.toHaveBeenCalled();
  });
});

describe("home: what's new", () => {
  it("offers it to a member who has not seen it, with the newcomer's first item for a fresh Acolyte", async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
    seenStore.get.mockResolvedValue(null);
    const page = await run();
    expect(page.whatsNew.items[0].lead).toBe('You start as an Acolyte.');
    expect(page.whatsNew.items.at(-1).link).toEqual({ text: 'Codex', href: '/codex' });
  });

  it('welcomes a newcomer without talking about changes they never saw', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
    seenStore.get.mockResolvedValue(null);
    const { whatsNew } = await run();
    expect(whatsNew).toMatchObject({
      eyebrow: 'Before you begin',
      title: 'Welcome to the Knights of New Order',
      lead: "Here's how the Order works:",
    });
    expect(whatsNew.items.map((item: { lead: string }) => item.lead)).toContain('Climb the ranks.');
  });

  it('gives a returning player the first item about their kept rank and XP', async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 12, guide: true });
    const { whatsNew } = await run();
    expect(whatsNew).toMatchObject({
      eyebrow: "What's new",
      title: 'Welcome to the new Knights of New Order',
      lead: "The Order has a new home. Here's what changed:",
    });
    expect(whatsNew.items[0].lead).toBe('Your rank and XP came with you.');
    expect(whatsNew.items.map((item: { lead: string }) => item.lead)).toContain('Climb higher.');
  });

  it('does not offer it once seen, nor to someone who has not joined', async () => {
    expect((await run()).whatsNew).toBeNull();
    playerRow.value = undefined;
    expect((await run()).whatsNew).toBeNull();
    expect(seenStore.get).toHaveBeenCalledTimes(1);
  });

  it('records it as seen through the form action and leaves the player on /home', async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 12, guide: false });
    const dismiss = (actions as Record<string, (e: never) => Promise<unknown>>).dismissWhatsNew;
    expect(await dismiss({ locals: { user: { id: 7 } } } as never)).toBeUndefined();
    expect(seenStore.set).toHaveBeenCalledWith(7, {
      rank: 'Knight',
      level: 12,
      guide: false,
      whatsNew: true,
    });
  });

  it('fails when the store cannot record the dismissal so the dialog stays up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seenStore.set.mockRejectedValue(new Error('down'));
    const dismiss = (actions as Record<string, (e: never) => Promise<unknown>>).dismissWhatsNew;
    expect(await dismiss({ locals: { user: { id: 7 } } } as never)).toMatchObject({
      status: 500,
      data: { message: 'Could not close this. Try again.', whatsNewFailed: true },
    });
    vi.restoreAllMocks();
  });
});
