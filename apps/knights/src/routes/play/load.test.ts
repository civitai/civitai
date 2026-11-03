import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getApprentice = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const getRecap = vi.hoisted(() => vi.fn());
const dismissRecap = vi.hoisted(() => vi.fn());
const pickHiddenCheck = vi.hoisted(() => vi.fn());
const hasUnseenReset = vi.hoisted(() => vi.fn());
const readHiddenNotices = vi.hoisted(() => vi.fn());
const voteLockUntil = vi.hoisted(() => vi.fn());
const pickYesNo = vi.hoisted(() => vi.fn());
const yesNoSettings = vi.hoisted(() => ({ share: 0.7, stretch: 8 }));
const queueDeps = vi.hoisted(() => ({
  now: () => new Date('2026-12-15T12:00:00Z'),
  voteLimits: undefined as unknown,
}));
const skipList = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn() }));
const NOW = new Date('2026-12-15T12:00:00Z');
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps }));
vi.mock('$lib/server/queue/vote-rate', () => ({ voteLockUntil }));
vi.mock('$lib/server/daily/daily.service', () => ({ getDailyStatus, getRecap, dismissRecap }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/smites/smites.service', () => ({
  hasUnseenReset,
  dismissResetNotice: vi.fn(),
}));
vi.mock('$lib/server/skip-runtime', () => ({ skipStore: skipList }));
const seenStore = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('$lib/server/seen-runtime', () => ({ seenStore }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 0.5 }) }));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  pickHiddenCheck,
  answerHiddenCheck: vi.fn(),
  readHiddenNotices,
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => yesNoSettings }));
vi.mock('$lib/server/apprenticeship/runtime', () => ({
  apprenticeDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/apprenticeship/apprenticeship.service', () => ({
  answerApprentice: vi.fn(),
  acknowledgeCheckpoint: vi.fn(),
  getApprentice,
}));

const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));

const { load, actions } = await import('./+page.server');

const run = (user: Record<string, unknown> = {}) =>
  load({ locals: { user: { id: 7, ...user } }, depends: vi.fn() } as never) as Promise<
    Record<string, any>
  >;

beforeEach(() => {
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  getPlayerStatus.mockReset();
  getApprentice.mockReset();
  getFeed.mockReset();
  getFeed.mockResolvedValue(null);
  skipList.list.mockReset();
  skipList.list.mockResolvedValue([]);
  seenStore.get.mockReset();
  seenStore.get.mockResolvedValue({ rank: 'Knight', level: 5, guide: true });
  seenStore.set.mockReset();
  getDailyStatus.mockReset();
  getDailyStatus.mockResolvedValue({ votes: 3 });
  getRecap.mockReset();
  getRecap.mockResolvedValue(null);
  dismissRecap.mockReset();
  pickHiddenCheck.mockReset();
  pickHiddenCheck.mockResolvedValue(null);
  hasUnseenReset.mockReset();
  hasUnseenReset.mockResolvedValue(false);
  readHiddenNotices.mockReset();
  readHiddenNotices.mockResolvedValue([]);
  voteLockUntil.mockReset();
  pickYesNo.mockReset();
  pickYesNo.mockResolvedValue(null);
  yesNoSettings.share = 0.7;
  queueDeps.voteLimits = undefined;
});

describe('play load and the conversion switch', () => {
  it('hides the Convert link unless conversion is switched on', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    const previous = process.env.KNIGHTS_CONVERSION_ENABLED;
    try {
      delete process.env.KNIGHTS_CONVERSION_ENABLED;
      expect((await run()).conversionOpen).toBe(false);
      process.env.KNIGHTS_CONVERSION_ENABLED = 'yes';
      expect((await run()).conversionOpen).toBe(false);
      process.env.KNIGHTS_CONVERSION_ENABLED = 'true';
      expect((await run()).conversionOpen).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KNIGHTS_CONVERSION_ENABLED;
      else process.env.KNIGHTS_CONVERSION_ENABLED = previous;
    }
  });
});

describe('play load', () => {
  const progress = { answered: 12, graded: 12, correct: 9, accuracy: 0.75 };

  it('sends an Acolyte to the apprenticeship, with the standing and no answer', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
    getApprentice.mockResolvedValue({
      kind: 'question',
      progress,
      item: {
        kind: 'rating',
        referenceId: 5,
        questionKey: 'q',
        prompt: 'P',
        options: [{ value: '1', label: 'PG' }],
        imageKey: 'k',
        width: 1,
        height: 2,
      },
    });

    const page = await run();

    expect(page.mode).toBe('apprentice');
    expect(page.status).toMatchObject({ rank: 'Acolyte', level: 1 });
    expect(page.apprentice).toMatchObject({
      kind: 'question',
      prompt: 'P',
      progress: { accuracy: 0.75, bar: 0.75, knightLevel: 20 },
      item: { kind: 'rating', referenceId: 5, src: 'k' },
    });
    expect(JSON.stringify(page.apprentice)).not.toMatch(/correctAnswer|"answer"|correctLabel/);
  });

  it('gives a checkpoint recap with the missed items and their right answers', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    getApprentice.mockResolvedValue({
      kind: 'checkpoint',
      progress,
      checkpoint: {
        total: 20,
        right: 14,
        coach: true,
        missed: [
          {
            kind: 'rating',
            referenceId: 1,
            imageKey: 'k1',
            width: 10,
            height: 20,
            answerLabel: 'PG-13',
            correctLabel: 'R',
            explanation: 'because',
          },
        ],
      },
    });

    const page = await run();

    expect(page.apprentice).toMatchObject({
      kind: 'checkpoint',
      total: 20,
      right: 14,
      coach: true,
      missed: [{ src: 'k1', answerLabel: 'PG-13', correctLabel: 'R', explanation: 'because' }],
    });
  });

  it('tells an Acolyte with nothing left to practise on, not an error', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 3 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    expect((await run()).apprentice.kind).toBe('exhausted');
  });

  it('celebrates levels 5, 10 and 15 for an Acolyte and quietly records every other level', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 10 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 9, guide: true });

    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'level',
      level: 10,
      milestone: expect.stringMatching(/halfway/),
    });
    expect(seenStore.set).not.toHaveBeenCalled();

    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 11 });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 10, guide: true });
    const quiet = await run();
    expect(quiet.progress).toBeNull();
    expect(seenStore.set).toHaveBeenCalledWith(7, { rank: 'Acolyte', level: 11, guide: true });
  });

  it('still celebrates a milestone the player jumped past between loads', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 11 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 9, guide: true });

    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'level',
      milestoneLevel: 10,
      milestone: expect.stringMatching(/halfway/),
    });
    expect(seenStore.set).not.toHaveBeenCalled();
  });

  it('tells a newly knighted player about the rank, not a summary', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 20 });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 20, guide: true });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(page.progress).toMatchObject({ kind: 'rank', rank: 'Knight' });
  });

  it('keeps Knights on the queue', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(getApprentice).not.toHaveBeenCalled();
  });

  it('gives a Knight the day, evaluated at the injected clock, and the recap', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
    getRecap.mockResolvedValue({ cast: 30 });

    const page = await run();

    expect(page.daily).toEqual({ votes: 3 });
    expect(page.recap).toEqual({ cast: 30 });
    expect(getDailyStatus).toHaveBeenCalledWith(expect.anything(), {
      playerId: 7,
      rank: 'Knight',
      now: NOW,
    });
    expect(getRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('keeps the daily loop off the apprenticeship page', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    await run();
    expect(getDailyStatus).not.toHaveBeenCalled();
  });
});

describe('play load vote pacing', () => {
  const limits = [{ windowSeconds: 60, max: 3 }];
  const until = new Date('2026-12-15T12:00:30Z');

  beforeEach(() => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
    queueDeps.voteLimits = limits;
  });

  it('shows the lockout instead of the next image while the player is paced', async () => {
    voteLockUntil.mockResolvedValue(until);

    const page = await run();

    expect(page.lockoutSeconds).toBe(30);
    expect(page.item).toBeNull();
    expect(getFeed).not.toHaveBeenCalled();
    expect(pickHiddenCheck).not.toHaveBeenCalled();
    expect(pickYesNo).not.toHaveBeenCalled();
    expect(voteLockUntil).toHaveBeenCalledWith(expect.anything(), 7, NOW, limits);
  });

  it('serves the feed when the player is not paced', async () => {
    voteLockUntil.mockResolvedValue(null);
    expect((await run()).lockoutSeconds).toBeNull();
    expect(getFeed).toHaveBeenCalled();
  });

  it('never paces a moderator', async () => {
    await run({ isModerator: true });
    expect(voteLockUntil).not.toHaveBeenCalled();
    expect(getFeed).toHaveBeenCalled();
  });
});

describe('play load when not sworn in', () => {
  it('sends a user with no player row to the front page to join', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/' });
    expect(getApprentice).not.toHaveBeenCalled();
  });
});

describe('play load feed', () => {
  const feed = {
    question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
    items: [{ id: 3, imageKey: 'key-3', width: 1, height: 1 }],
  };
  const hidden = {
    referenceId: 5,
    question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
    imageKey: 'key-9',
    width: 1,
    height: 1,
  };
  beforeEach(() => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 0, maxSmites: 3 });
    getFeed.mockResolvedValue(feed);
  });

  it('serves a queue item and a hidden check in the same shape, with nothing that tells them apart', async () => {
    const queued = await run();
    pickHiddenCheck.mockResolvedValue(hidden);
    const check = await run();

    expect(Object.keys(check.item).sort()).toEqual(Object.keys(queued.item).sort());
    expect(Object.keys(check.question).sort()).toEqual(Object.keys(queued.question).sort());
    expect(check.item.src).toBe('key-9');
    expect(typeof check.item.id).toBe('string');
    expect(check.item.id).toHaveLength(queued.item.id.length);
    expect(JSON.stringify(check)).not.toMatch(/hidden|referenceId|pool|answer/i);
  });

  it('leaves out what the player skipped when it picks the next item of every kind', async () => {
    skipList.list.mockResolvedValue([
      { kind: 'queue', id: 3 },
      { kind: 'hidden', id: 5 },
      { kind: 'yesno', id: 8 },
    ]);
    yesNoSettings.share = 1;
    pickYesNo.mockResolvedValue(null);

    try {
      await run();
    } finally {
      yesNoSettings.share = 0.7;
    }

    expect(getFeed).toHaveBeenCalledWith(expect.anything(), 7, { limit: 1, exclude: [3] });
    expect(pickHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exclude: [5] })
    );
    expect(pickYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exclude: [8] })
    );
  });

  it('serves no hidden check when the queue is empty', async () => {
    getFeed.mockResolvedValue(null);
    pickHiddenCheck.mockResolvedValue(hidden);
    expect((await run()).item).toBeNull();
  });

  it('serves nothing while a career reset is due', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 3, maxSmites: 3 });
    const page = await run();
    expect(page.item).toBeNull();
    expect(page.resetPending).toBe(true);
  });

  it('carries the reset notice and the notices from hidden checks', async () => {
    hasUnseenReset.mockResolvedValue(true);
    readHiddenNotices.mockResolvedValue([{ title: 'T', message: 'M' }]);
    const page = await run();
    expect(page.resetNotice).toBe(true);
    expect(page.notices).toEqual([{ title: 'T', message: 'M' }]);
  });

  it('shows the reset notice on the apprenticeship page, where a reset player lands', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, smites: 0, maxSmites: 3 });
    getApprentice.mockResolvedValue({
      kind: 'exhausted',
      progress: { answered: 0, graded: 0, correct: 0, accuracy: null },
    });
    hasUnseenReset.mockResolvedValue(true);
    const page = await run();
    expect(page.mode).toBe('apprentice');
    expect(page.resetNotice).toBe(true);
  });

  it('asks for a check only for the question the feed shows, at the configured rate', async () => {
    await run();
    expect(pickHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ questionKey: 'q', rate: 0.5 })
    );
  });
});

describe('play load yes/no questions', () => {
  const offer = {
    itemId: 90417,
    prompt: 'Is a hat worn?',
    imageKey: 'key-41',
    width: 2,
    height: 3,
    banner: { heading: 'Violence' },
  };
  beforeEach(() => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 0, maxSmites: 3 });
    getFeed.mockResolvedValue({
      question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
      items: [{ id: 3, imageKey: 'key-3', width: 1, height: 1 }],
    });
  });

  it('serves a question in the shape of any other item, sealed, with only its words, image and banner', async () => {
    pickYesNo.mockResolvedValue(offer);
    const rated = await (async () => {
      pickYesNo.mockResolvedValueOnce(null);
      return run();
    })();
    const page = await run();

    expect(Object.keys(page.item).sort()).toEqual(Object.keys(rated.item).sort());
    expect(page.item).toMatchObject({ src: 'key-41', width: 2, height: 3 });
    expect(typeof page.item.id).toBe('string');
    expect(page.question).toEqual({
      key: 'yesno',
      kind: 'bool',
      prompt: 'Is a hat worn?',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    expect(page.banner).toEqual({ heading: 'Violence' });
    expect(JSON.stringify(page)).not.toContain('90417');
  });

  it('offers a hidden check before rolling for a question, so its rate holds whatever the yes/no share', async () => {
    pickHiddenCheck.mockResolvedValue({
      referenceId: 5,
      question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
      imageKey: 'key-9',
      width: 1,
      height: 1,
    });
    pickYesNo.mockResolvedValue(offer);

    const page = await run();

    expect(page.item.src).toBe('key-9');
    expect(page.banner).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();
  });

  it('falls back to the rating, with no banner, when no question is offered', async () => {
    const page = await run();
    expect(page.question.key).toBe('q');
    expect(page.banner).toBeNull();
    expect(pickYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, rank: 'Knight', share: 0.7, stretch: 8, force: false })
    );
  });

  it('serves questions when there is no rating to show, and none while paced, reset or switched off', async () => {
    getFeed.mockResolvedValue(null);
    pickYesNo.mockResolvedValue(offer);
    expect((await run()).item).toMatchObject({ src: 'key-41' });
    expect(pickYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ force: true })
    );

    pickYesNo.mockClear();
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 3, maxSmites: 3 });
    expect((await run()).item).toBeNull();
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 0, maxSmites: 3 });
    queueDeps.voteLimits = [{ windowSeconds: 60, max: 3 }];
    voteLockUntil.mockResolvedValue(new Date('2026-12-15T12:00:30Z'));
    expect((await run()).item).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();

    queueDeps.voteLimits = undefined;
    yesNoSettings.share = 0;
    getFeed.mockResolvedValue(null);
    expect((await run()).item).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();
  });
});

describe('dismissRecap action', () => {
  const run = () => actions.dismissRecap({ locals: { user: { id: 7 } } } as never);

  it('stores the dismissal for the caller at the injected clock', async () => {
    await run();
    expect(dismissRecap).toHaveBeenCalledWith(expect.anything(), { playerId: 7, now: NOW });
  });

  it('tells the player when it could not be stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dismissRecap.mockRejectedValue(new Error('down'));

    expect(await run()).toMatchObject({
      status: 500,
      data: { message: 'Could not dismiss the recap. Try again.', recapFailed: true },
    });
    expect(log).toHaveBeenCalled();
  });
});

describe('play load notices', () => {
  it('announces a new level once it is ahead of what the player was told', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 6 });
    const page = await run();
    expect(page.progress).toMatchObject({ kind: 'level', rank: 'Knight', level: 6 });
    expect(page.showGuide).toBe(false);
  });

  it('carries what a new rank brings, so the notice can say it', async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 20, guide: true });
    getPlayerStatus.mockResolvedValue({ rank: 'Templar', level: 21 });
    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'rank',
      rank: 'Templar',
      level: 21,
      levels: '21–40',
      voteWeight: 1.5,
      goldMultiplier: 1.25,
    });
  });

  it('offers the rating guide to a player who has not dismissed it, with every level described', async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 5, guide: false });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    const page = await run();
    expect(page.showGuide).toBe(true);
    expect(page.progress).toBeNull();
    expect(page.ratingGuide.map((g: { level: number }) => g.level)).toEqual([1, 2, 4, 8, 16, 32]);
  });
});

describe('play progress actions', () => {
  const call = (name: 'dismissGuide' | 'dismissProgress') =>
    (actions as Record<string, (e: never) => Promise<unknown>>)[name]({
      locals: { user: { id: 7 } },
    } as never);

  it('records the current standing as seen', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Templar', level: 12 });
    await call('dismissProgress');
    expect(seenStore.set).toHaveBeenCalledWith(7, { rank: 'Templar', level: 12, guide: true });
  });

  it('records the guide as read without touching what was seen', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 4, guide: false });
    await call('dismissGuide');
    expect(seenStore.set).toHaveBeenCalledWith(7, { rank: 'Knight', level: 4, guide: true });
  });

  it('fails when the store is down so the notice is not lost silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    seenStore.set.mockRejectedValue(new Error('down'));
    expect(await call('dismissGuide')).toMatchObject({ status: 500 });
  });
});

describe('play load for a muted player', () => {
  beforeEach(() => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    getFeed.mockResolvedValue({
      question: { key: 'q', kind: 'rating', prompt: 'P', options: [] },
      items: [{ id: 1, imageKey: 'k', width: 1, height: 2 }],
    });
  });

  it('says so and serves no item, hidden check or yes/no question, to any rank', async () => {
    for (const rank of ['Knight', 'Acolyte']) {
      getPlayerStatus.mockResolvedValue({ rank, level: 5, smites: 0, maxSmites: 3 });
      getApprentice.mockResolvedValue({ kind: 'exhausted', progress: {} });
      const page = await run();
      expect(page).toMatchObject({ mode: 'queue', muted: true, item: null, question: null });
      expect(page.status).toMatchObject({ rank });
    }
    expect(getFeed).not.toHaveBeenCalled();
    expect(getApprentice).not.toHaveBeenCalled();
    expect(pickHiddenCheck).not.toHaveBeenCalled();
    expect(pickYesNo).not.toHaveBeenCalled();
  });

  it('marks an unmuted player as not muted', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: false });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5, smites: 0, maxSmites: 3 });
    expect(await run()).toMatchObject({ muted: false, item: { src: 'k' } });
    expect(getFeed).toHaveBeenCalled();
  });
});
