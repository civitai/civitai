import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const playerPrefs = vi.hoisted(() => vi.fn());
const setYesNoQuestions = vi.hoisted(() => vi.fn());
const yesNo = vi.hoisted(() => ({ playerDefault: false }));
const PRIMARY = vi.hoisted(() => ({ client: 'primary' }));
vi.mock('$lib/server/db', () => ({ db: PRIMARY }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/player-prefs', () => ({ playerPrefs, setYesNoQuestions }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ ...yesNo }) }));

const { load, actions } = await import('./+page.server');

const NOW = new Date('2026-12-15T12:00:00Z');

const run = () => load({ locals: { user: { id: 7 } } } as never) as Promise<Record<string, any>>;

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.questions({
    locals: { user: { id: 7 } },
    request: new Request('http://knights.test/settings?/questions', { method: 'POST', body }),
  } as never) as Promise<any>;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 22 });
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  playerPrefs.mockReset();
  playerPrefs.mockResolvedValue({ yesNo: true });
  setYesNoQuestions.mockReset();
  setYesNoQuestions.mockResolvedValue(undefined);
  yesNo.playerDefault = false;
});

describe('settings load', () => {
  it('sends a user who has not joined to the home page', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/home' });
  });

  it("shows the player's switch, read with the Config page default", async () => {
    yesNo.playerDefault = true;
    playerPrefs.mockResolvedValue({ yesNo: false });

    expect(await run()).toMatchObject({ questions: { available: true, on: false } });
    expect(playerPrefs).toHaveBeenCalledWith(PRIMARY, 7, true);
  });

  it('offers no switch to an Acolyte, whose practice questions are part of training', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    expect(await run()).toMatchObject({ questions: { available: false } });
  });
});

describe('the questions action', () => {
  it.each([
    ['off', false],
    ['on', true],
  ])('stores %s for the signed-in player', async (value, on) => {
    expect(await post({ questions: value })).toEqual({ questions: on });
    expect(setYesNoQuestions).toHaveBeenCalledWith(PRIMARY, 7, on, NOW);
  });

  it('refuses anything but on or off, storing nothing', async () => {
    expect(await post({ questions: 'maybe' })).toMatchObject({ status: 400 });
    expect(await post({})).toMatchObject({ status: 400 });
    expect(setYesNoQuestions).not.toHaveBeenCalled();
  });

  it('refuses a muted player, storing nothing', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await post({ questions: 'off' })).toMatchObject({ status: 403 });
    expect(setYesNoQuestions).not.toHaveBeenCalled();
  });

  it('refuses an Acolyte, storing nothing', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    expect(await post({ questions: 'off' })).toMatchObject({ status: 403 });
    expect(setYesNoQuestions).not.toHaveBeenCalled();
  });

  it('sends a user who has not joined to the home page, storing nothing', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(post({ questions: 'off' })).rejects.toMatchObject({ status: 303 });
    expect(setYesNoQuestions).not.toHaveBeenCalled();
  });
});
