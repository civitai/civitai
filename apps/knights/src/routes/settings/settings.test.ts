import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const playerPrefs = vi.hoisted(() => vi.fn());
const setYesNoQuestions = vi.hoisted(() => vi.fn());
const hiddenTagGroups = vi.hoisted(() => vi.fn());
const setTagGroupHidden = vi.hoisted(() => vi.fn());
const yesNo = vi.hoisted(() => ({ playerDefault: false }));
const startAtRow = vi.hoisted(() => ({ value: undefined as { startAt: Date } | undefined }));
const PRIMARY = vi.hoisted(() => ({
  client: 'primary',
  selectFrom: () => ({
    select: () => ({ where: () => ({ executeTakeFirst: async () => startAtRow.value }) }),
  }),
}));
vi.mock('$lib/server/db', () => ({ db: PRIMARY }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/player-prefs', () => ({
  playerPrefs,
  setYesNoQuestions,
  hiddenTagGroups,
  setTagGroupHidden,
}));
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
  hiddenTagGroups.mockReset();
  hiddenTagGroups.mockResolvedValue([]);
  setTagGroupHidden.mockReset();
  setTagGroupHidden.mockResolvedValue(undefined);
  yesNo.playerDefault = false;
  startAtRow.value = { startAt: new Date('2026-03-14T00:00:00Z') };
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
    expect(await run()).toMatchObject({
      questions: { available: false },
      tagGroups: { available: false },
    });
  });

  it("lists every preset group with the player's choice", async () => {
    hiddenTagGroups.mockResolvedValue(['gore']);
    expect((await run()).tagGroups).toEqual({
      available: true,
      groups: [
        { key: 'anime', label: 'Anime', description: 'Anime and manga', hidden: false },
        { key: 'furry', label: 'Furry', description: 'Anthro and furry', hidden: false },
        { key: 'gore', label: 'Gore', description: 'Gore and body horror', hidden: true },
        { key: 'political', label: 'Political', description: 'Political content', hidden: false },
      ],
    });
    expect(hiddenTagGroups).toHaveBeenCalledWith(PRIMARY, 7);
  });
});

describe('settings load, career', () => {
  it('gives every player, an Acolyte too, the date they were sworn in for the restart section', async () => {
    expect((await run()).career).toEqual({ swornIn: '2026-03-14T00:00:00.000Z' });
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    expect((await run()).career).toEqual({ swornIn: '2026-03-14T00:00:00.000Z' });
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

const postGroup = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.tagGroup({
    locals: { user: { id: 7 } },
    request: new Request('http://knights.test/settings?/tagGroup', { method: 'POST', body }),
  } as never) as Promise<any>;
};

describe('the tag group action', () => {
  it.each([
    ['on', true],
    ['off', false],
  ])('stores hidden=%s for the group', async (value, hidden) => {
    expect(await postGroup({ key: 'furry', hidden: value })).toEqual({
      tagGroup: 'furry',
      hidden,
    });
    expect(setTagGroupHidden).toHaveBeenCalledWith(PRIMARY, 7, 'furry', hidden, NOW);
  });

  it('refuses a group that is not a preset one, or a value but on or off, storing nothing', async () => {
    expect(await postGroup({ key: 'sexual', hidden: 'on' })).toMatchObject({ status: 400 });
    expect(await postGroup({ key: 'anime', hidden: 'maybe' })).toMatchObject({ status: 400 });
    expect(setTagGroupHidden).not.toHaveBeenCalled();
  });

  it('refuses a muted player and an Acolyte, storing nothing', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await postGroup({ key: 'anime', hidden: 'on' })).toMatchObject({ status: 403 });
    getStanding.mockResolvedValue({ banned: false, muted: false });
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    expect(await postGroup({ key: 'anime', hidden: 'on' })).toMatchObject({ status: 403 });
    expect(setTagGroupHidden).not.toHaveBeenCalled();
  });
});
