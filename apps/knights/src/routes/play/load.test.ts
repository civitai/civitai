import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_UPDATE_ID } from '$lib/server/whats-new/entries';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getApprentice = vi.hoisted(() => vi.fn());
const getApprenticeProgress = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const getDailyStatus = vi.hoisted(() => vi.fn());
const railFor = vi.hoisted(() => vi.fn());
const pickHiddenCheck = vi.hoisted(() => vi.fn());
const hasUnseenReset = vi.hoisted(() => vi.fn());
const readHiddenNotices = vi.hoisted(() => vi.fn());
const pauseFor = vi.hoisted(() => vi.fn());
const pickYesNo = vi.hoisted(() => vi.fn());
const burstDue = vi.hoisted(() => vi.fn());
const servedHistory = vi.hoisted(() => vi.fn());
const yesNoSettings = vi.hoisted(() => ({ share: 0.7, stretch: 8 }));
const playerPrefs = vi.hoisted(() => vi.fn());
const queueDeps = vi.hoisted(() => ({
  now: () => new Date('2026-12-15T12:00:00Z'),
}));
const skipList = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn() }));
const NOW = new Date('2026-12-15T12:00:00Z');
// Distinct objects, so a read that takes the primary instead of the replica (or the reverse) fails `toBe`.
const PRIMARY = vi.hoisted(() => ({ client: 'primary' }));
const REPLICA = vi.hoisted(() => ({ client: 'replica' }));
vi.mock('$lib/server/db', () => ({ db: PRIMARY, dbRead: REPLICA }));
const inquisitorQueue = vi.hoisted(() => ({ enabled: true, serveJudged: true }));
vi.mock('$lib/server/skill-check/runtime', () => ({
  skillChecks: async () => ({
    enabled: inquisitorQueue.enabled,
    poolCap: 500,
    serveJudged: inquisitorQueue.serveJudged,
  }),
}));
vi.mock('./inquisitor.server', () => ({
  inquisitorView: async () => ({ mode: 'inquisitor' }),
  inquisitorActions: {},
}));
// Consent has its own tests (membership.test.ts); these cover what /play does once it is given.
vi.mock('$lib/server/membership', async (original) => ({
  ...(await original<typeof import('$lib/server/membership')>()),
  consented: vi.fn(async () => true),
  requireConsent: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key, THUMBNAIL_WIDTH: 192 }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps }));
vi.mock('$lib/server/vote-limits/runtime', () => ({ pauseFor, voteGate: { guard: vi.fn() } }));
vi.mock('$lib/server/rail-runtime', () => ({ railFor }));
vi.mock('$lib/server/daily/daily.service', () => ({ getDailyStatus }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/smites/smites.service', () => ({
  hasUnseenReset,
  dismissResetNotice: vi.fn(),
}));
vi.mock('$lib/server/skip-runtime', () => ({ skipStore: skipList }));
const seenStore = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('$lib/server/seen-runtime', () => ({ seenStore }));
vi.mock('$lib/server/hidden/runtime', () => ({
  hiddenSettings: () => ({ rate: 0.5, probationShare: 0.25 }),
}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  hiddenItemId: (id: number) => -id,
  pickHiddenCheck,
  answerHiddenCheck: vi.fn(),
  readHiddenNotices,
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo }));
vi.mock('$lib/server/yesno/cadence', () => ({
  burstDue,
  burstRoller: () => () => 0,
  servedHistory,
}));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => yesNoSettings }));
vi.mock('$lib/server/player-prefs', () => ({ playerPrefs }));
vi.mock('$lib/server/apprenticeship/runtime', () => ({
  apprenticeDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/apprenticeship/apprenticeship.service', () => ({
  answerApprentice: vi.fn(),
  acknowledgeCheckpoint: vi.fn(),
  getApprentice,
  getApprenticeProgress,
}));

const acolyteLevelGoldSince = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/apprenticeship/level-gold', async (original) => ({
  ...(await original<typeof import('$lib/server/apprenticeship/level-gold')>()),
  acolyteLevelGoldSince,
}));

const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));

const { load, actions } = await import('./+page.server');

const run = (user: Record<string, unknown> = {}) => {
  // The load reads the player's rating for the gold a vote records; each test gives only the status fields it checks.
  const given = getPlayerStatus.getMockImplementation();
  if (given)
    getPlayerStatus.mockImplementation(async (...args: unknown[]) => {
      const status = await given(...args);
      return status && { rating: { belowBar: false }, ...status };
    });
  return load({ locals: { user: { id: 7, ...user } }, depends: vi.fn() } as never) as Promise<
    Record<string, any>
  >;
};

beforeEach(() => {
  acolyteLevelGoldSince.mockReset();
  acolyteLevelGoldSince.mockResolvedValue(0);
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  getPlayerStatus.mockReset();
  getApprentice.mockReset();
  getApprenticeProgress.mockReset();
  getFeed.mockReset();
  getFeed.mockResolvedValue(null);
  skipList.list.mockReset();
  skipList.list.mockResolvedValue([]);
  seenStore.get.mockReset();
  seenStore.get.mockResolvedValue({
    rank: 'Knight',
    level: 5,
    guide: true,
    whatsNew: true,
    consent: true,
  });
  seenStore.set.mockReset();
  getDailyStatus.mockReset();
  getDailyStatus.mockResolvedValue({ votes: 3 });
  railFor.mockReset();
  railFor.mockResolvedValue({ standing: null, activity: null });
  pickHiddenCheck.mockReset();
  pickHiddenCheck.mockResolvedValue(null);
  hasUnseenReset.mockReset();
  hasUnseenReset.mockResolvedValue(false);
  readHiddenNotices.mockReset();
  readHiddenNotices.mockResolvedValue([]);
  pauseFor.mockReset();
  pickYesNo.mockReset();
  pickYesNo.mockResolvedValue(null);
  burstDue.mockReset();
  burstDue.mockReturnValue(true);
  servedHistory.mockReset();
  servedHistory.mockResolvedValue([]);
  yesNoSettings.share = 0.7;
  playerPrefs.mockReset();
  playerPrefs.mockResolvedValue({ yesNo: true });
});

describe('play load', () => {
  const progress = { answered: 12, graded: 12, correct: 9, accuracy: 0.75 };

  it.each([
    [true, 0.5],
    [false, 0],
  ])(
    'mixes skill checks into the apprenticeship at the hidden-check rate only with the inquisitor queue on (on: %s)',
    async (enabled, skillCheckRate) => {
      getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
      getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
      inquisitorQueue.enabled = enabled;
      try {
        await run();
      } finally {
        inquisitorQueue.enabled = true;
      }
      expect(getApprentice).toHaveBeenCalledWith(expect.anything(), 7, { skillCheckRate });
    }
  );

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
      progress: { accuracy: 0.75, bar: 0.75, knightLevel: 20, window: 100 },
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

  it('shows a level-up card on every Acolyte level, with the gold for the levels since the last one seen', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 11 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 10, guide: true, whatsNew: true });
    acolyteLevelGoldSince.mockResolvedValue(2000);

    const page = await run();
    expect(page.progress).toMatchObject({ kind: 'level', level: 11, levelGold: 2000 });
    expect(page.progress).not.toHaveProperty('milestone');
    expect(acolyteLevelGoldSince).toHaveBeenCalledWith(expect.anything(), 7, 10, 11);
    expect(seenStore.set).not.toHaveBeenCalled();
  });

  it('keeps the milestone words for levels 5, 10 and 15', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 10 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 9, guide: true, whatsNew: true });
    acolyteLevelGoldSince.mockResolvedValue(100);

    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'level',
      level: 10,
      milestone: expect.stringMatching(/halfway/),
      levelGold: 100,
    });
    expect(acolyteLevelGoldSince).toHaveBeenCalledWith(expect.anything(), 7, 9, 10);
  });

  it('still celebrates a milestone the player jumped past between loads', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 11 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 9, guide: true, whatsNew: true });

    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'level',
      milestoneLevel: 10,
      milestone: expect.stringMatching(/halfway/),
    });
    expect(seenStore.set).not.toHaveBeenCalled();
    // The card's gold stops at the milestone it celebrates, not the level the player has since reached.
    expect(acolyteLevelGoldSince).toHaveBeenCalledWith(expect.anything(), 7, 9, 10);
  });

  it('prices a card for every level since the player last looked', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 15 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 2, guide: true, whatsNew: true });
    await run();
    expect(acolyteLevelGoldSince).toHaveBeenCalledWith(expect.anything(), 7, 2, 15);
  });

  it('tells a newly knighted player about the rank, not a summary', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 20 });
    seenStore.get.mockResolvedValue({ rank: 'Acolyte', level: 20, guide: true, whatsNew: true });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(page.progress).toMatchObject({ kind: 'rank', rank: 'Knight' });
  });

  it("gives a rank-up the new rank's benefits: vote weight, gold multiplier and daily gold cap range", async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Templar', level: 50 });
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 49, guide: true, whatsNew: true });
    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'rank',
      rank: 'Templar',
      voteWeight: 1.5,
      goldMultiplier: 1.25,
      dailyGoldCap: { from: 140_000, to: 180_000 },
    });
    expect(page.progress).not.toHaveProperty('previous');
  });

  it('gives a skipped rank the benefits of the rank reached, not of the ranks between', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Paladin', level: 90 });
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 49, guide: true, whatsNew: true });
    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'rank',
      rank: 'Paladin',
      voteWeight: 2,
      goldMultiplier: 1.5,
      dailyGoldCap: { from: 200_000, to: 400_000 },
    });
  });

  it('keeps Knights on the queue', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(getApprentice).not.toHaveBeenCalled();
  });

  it('gives a Knight the day, evaluated at the injected clock, and no daily popup', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });

    const page = await run();

    expect(page.daily).toEqual({ votes: 3, goldPerVote: 100 });
    expect(page).not.toHaveProperty('recap');
    expect(getDailyStatus).toHaveBeenCalledWith(expect.anything(), {
      playerId: 7,
      rank: 'Knight',
      level: 2,
      now: NOW,
    });
  });

  it("gives a Knight the rail: board position, gap and the Order's activity, read at the injected clock", async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, fervor: 25 });
    const rail = { standing: { position: 14, total: 312, gap: 38 }, activity: 1240 };
    railFor.mockResolvedValue(rail);

    expect((await run()).rail).toEqual(rail);
    expect(railFor).toHaveBeenCalledWith(7, NOW, 25);
  });

  it('reads no rail for the apprenticeship, which has no board', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    expect((await run()).rail).toBeUndefined();
    expect(railFor).not.toHaveBeenCalled();
  });

  it('keeps the daily loop off the apprenticeship page', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress });
    await run();
    expect(getDailyStatus).not.toHaveBeenCalled();
  });
});

describe('play load vote pacing', () => {
  const until = new Date('2026-12-15T12:00:30Z');

  beforeEach(() => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2 });
  });

  it('shows the lockout instead of the next image while the player is paced', async () => {
    pauseFor.mockResolvedValue({ until, windowSeconds: null });

    const page = await run();

    expect(page.lockoutSeconds).toBe(30);
    expect(page.item).toBeNull();
    expect(getFeed).not.toHaveBeenCalled();
    expect(pickHiddenCheck).not.toHaveBeenCalled();
    expect(pickYesNo).not.toHaveBeenCalled();
    expect(pauseFor).toHaveBeenCalledWith(expect.anything(), 7, NOW);
  });

  it('passes on the window behind the pause, so the panel can name the limit', async () => {
    pauseFor.mockResolvedValue({ until, windowSeconds: 86400 });
    expect(await run()).toMatchObject({ lockoutSeconds: 30, lockoutWindowSeconds: 86400 });
    pauseFor.mockResolvedValue({ until, windowSeconds: null });
    expect(await run()).toMatchObject({ lockoutSeconds: 30, lockoutWindowSeconds: null });
  });

  it('serves the feed when the player is not paced', async () => {
    pauseFor.mockResolvedValue(null);
    expect((await run()).lockoutSeconds).toBeNull();
    expect(getFeed).toHaveBeenCalled();
  });

  it('serves a moderator the player feed while the inquisitor queue is switched off', async () => {
    inquisitorQueue.enabled = false;
    try {
      expect(await run({ isModerator: true })).toMatchObject({ mode: 'queue' });
      expect(getFeed).toHaveBeenCalled();
    } finally {
      inquisitorQueue.enabled = true;
    }
  });

  it('serves a moderator the inquisitor queue instead of the feed, unpaced', async () => {
    const data = await run({ isModerator: true });
    expect(data).toMatchObject({ mode: 'inquisitor' });
    expect(pauseFor).not.toHaveBeenCalled();
    expect(getFeed).not.toHaveBeenCalled();
  });
});

describe('play load when not sworn in', () => {
  it('sends a user with no player row to the home page to join', async () => {
    getPlayerStatus.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ status: 303, location: '/home' });
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

  it.each([
    [true, true],
    [false, false],
  ])(
    'draws mod-confirmed checks for a Knight only with the inquisitor queue on (on: %s)',
    async (enabled, skillChecks) => {
      inquisitorQueue.enabled = enabled;
      try {
        await run();
      } finally {
        inquisitorQueue.enabled = true;
      }
      expect(pickHiddenCheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skillChecks, serveJudged: true, rate: 0.5 })
      );
    }
  );

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

    expect(getFeed).toHaveBeenCalledWith(REPLICA, 7, { limit: 1, exclude: [3] });
    expect(pickHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exclude: [5] })
    );
    expect(pickYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exclude: [8] })
    );
  });

  it('reads the feed from the replica, and the player, their pace and their served history from the primary', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 2, smites: 0, maxSmites: 3 });
    pauseFor.mockResolvedValue(null);

    await run();

    expect(getFeed).toHaveBeenCalledTimes(1);
    expect(getFeed.mock.calls[0][0]).toBe(REPLICA);
    expect(getPlayerStatus.mock.calls[0][0]).toBe(PRIMARY);
    expect(pauseFor.mock.calls[0][0]).toBe(PRIMARY);
    expect(servedHistory.mock.calls[0][0]).toBe(PRIMARY);
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

  it('serves an Acolyte no apprenticeship item while their career reset is due', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 4, smites: 3, maxSmites: 3 });
    const page = await run();
    expect(page.mode).toBe('queue');
    expect(page.item).toBeNull();
    expect(page.resetPending).toBe(true);
    expect(getApprentice).not.toHaveBeenCalled();
  });

  it('carries the reset notice and the notices from hidden checks', async () => {
    hasUnseenReset.mockResolvedValue(true);
    readHiddenNotices.mockResolvedValue([
      { title: 'T', message: 'M', imageKey: 'img-key' },
      { title: 'T', message: 'M', imageKey: null },
    ]);
    const page = await run();
    expect(page.resetNotice).toBe(true);
    expect(page.notices).toEqual([
      { title: 'T', message: 'M', imageKey: 'img-key', imageSrc: 'img-key' },
      { title: 'T', message: 'M', imageKey: null, imageSrc: null },
    ]);
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
      expect.objectContaining({ questionKey: 'q', rate: 0.5, probationShare: 0.25 })
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
    category: { heading: 'Violence' },
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
    expect(page.category).toEqual({ heading: 'Violence' });
    expect(JSON.stringify(page)).not.toContain('90417');
  });

  it('serves a due question before rolling for a hidden check, and rolls the check only on a rating slot', async () => {
    pickHiddenCheck.mockResolvedValue({
      referenceId: 5,
      question: { key: 'q', kind: 'choice', prompt: 'Rate', options: [] },
      imageKey: 'key-9',
      width: 1,
      height: 1,
    });
    pickYesNo.mockResolvedValue(offer);

    expect((await run()).item.src).toBe('key-41');
    expect(pickHiddenCheck).not.toHaveBeenCalled();

    burstDue.mockReturnValue(false);
    pickYesNo.mockClear();
    const page = await run();
    expect(page.item.src).toBe('key-9');
    expect(page.banner).toBeNull();
    expect(page.category).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();
  });

  it('serves the rating while no burst is due, asking the cadence with the player’s history', async () => {
    const history = [{ yesno: false, key: 'r1' }];
    servedHistory.mockResolvedValue(history);
    burstDue.mockReturnValue(false);
    pickYesNo.mockResolvedValue(offer);

    const page = await run();
    expect(page.question.key).toBe('q');
    expect(pickYesNo).not.toHaveBeenCalled();
    expect(servedHistory).toHaveBeenCalledWith(expect.anything(), 7, undefined);
    expect(burstDue).toHaveBeenCalledWith(history, expect.any(Function));
  });

  it('falls back to the rating, with no banner, when no question is offered', async () => {
    const page = await run();
    expect(page.question.key).toBe('q');
    expect(page.banner).toBeNull();
    expect(page.category).toBeNull();
    expect(pickYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, rank: 'Knight', stretch: 8, force: true })
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
    pauseFor.mockResolvedValue({ until: new Date('2026-12-15T12:00:30Z'), windowSeconds: null });
    expect((await run()).item).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();

    pauseFor.mockResolvedValue(null);
    yesNoSettings.share = 0;
    getFeed.mockResolvedValue(null);
    expect((await run()).item).toBeNull();
    expect(pickYesNo).not.toHaveBeenCalled();
  });

  it('serves the rating, never a question, to a player who turned questions off in Knights settings', async () => {
    playerPrefs.mockResolvedValue({ yesNo: false });
    pickYesNo.mockResolvedValue(offer);

    const page = await run();

    expect(pickYesNo).not.toHaveBeenCalled();
    expect(page.question.kind).not.toBe('bool');
    expect(page.banner).toBeNull();
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
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 49, guide: true, whatsNew: true });
    getPlayerStatus.mockResolvedValue({ rank: 'Templar', level: 50 });
    const page = await run();
    expect(page.progress).toMatchObject({
      kind: 'rank',
      rank: 'Templar',
      level: 50,
      levels: '50–89',
      goldMultiplier: 1.25,
    });
  });

  it('offers the rating guide to a player who has not dismissed it, with every level described', async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 5, guide: false, whatsNew: true });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    const page = await run();
    expect(page.showGuide).toBe(true);
    expect(page.progress).toBeNull();
    expect(page.ratingGuide.map((g: { level: number }) => g.level)).toEqual([1, 2, 4, 8, 16, 32]);
  });
});

describe("play load: what's new", () => {
  it("offers what's new before the rating guide to a player who has not seen it, as a returning player", async () => {
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 5, guide: false });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    const page = await run();
    expect(page.whatsNew.items[0].lead).toBe('Your rank and XP came with you.');
    expect(page.whatsNew.title).toBe('Welcome to the new Knights of New Order');
    expect(page.showGuide).toBe(false);
  });

  it('tells a player with no v1 progress that they start as an Acolyte', async () => {
    seenStore.get.mockResolvedValue(null);
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 0 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress: {} });
    const page = await run();
    expect(page.whatsNew.items[0].lead).toBe('You start as an Acolyte.');
    expect(page.whatsNew.title).toBe('Welcome to the Knights of New Order');
    expect(page.showGuide).toBe(false);
  });

  it('counts an Acolyte with any XP as returning', async () => {
    seenStore.get.mockResolvedValue(null);
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 1, xpIntoLevel: 40 });
    getApprentice.mockResolvedValue({ kind: 'exhausted', progress: {} });
    expect((await run()).whatsNew.items[0].lead).toBe('Your rank and XP came with you.');
  });

  it('does not offer it once it has been seen', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    expect((await run()).whatsNew).toBeNull();
  });

  it('records it as seen, keeping the guide and standing that were stored', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 4, guide: false });
    const dismiss = (actions as Record<string, (e: never) => Promise<unknown>>).dismissWhatsNew;
    expect(await dismiss({ locals: { user: { id: 7 } } } as never)).toBeUndefined();
    expect(seenStore.set).toHaveBeenCalledWith(7, {
      rank: 'Knight',
      level: 4,
      guide: false,
      whatsNew: true,
      updatesSeen: LATEST_UPDATE_ID,
    });
  });

  it('fails when the store is down so the layout sends it again later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    seenStore.set.mockRejectedValue(new Error('down'));
    const dismiss = (actions as Record<string, (e: never) => Promise<unknown>>).dismissWhatsNew;
    expect(await dismiss({ locals: { user: { id: 7 } } } as never)).toMatchObject({ status: 500 });
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
    expect(seenStore.set).toHaveBeenCalledWith(7, {
      rank: 'Templar',
      level: 12,
      guide: true,
      whatsNew: true,
      consent: true,
    });
  });

  it('records the guide as read without touching what was seen', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5 });
    seenStore.get.mockResolvedValue({ rank: 'Knight', level: 4, guide: false, whatsNew: true });
    await call('dismissGuide');
    expect(seenStore.set).toHaveBeenCalledWith(7, {
      rank: 'Knight',
      level: 4,
      guide: true,
      whatsNew: true,
    });
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
      getApprenticeProgress.mockResolvedValue({ answered: 4, graded: 4, accuracy: 0.75 });
      const page = await run();
      expect(page).toMatchObject({ mode: 'queue', muted: true, item: null, question: null });
      expect(page.status).toMatchObject({ rank });
    }
    expect(getFeed).not.toHaveBeenCalled();
    expect(getApprentice).not.toHaveBeenCalled();
    expect(pickHiddenCheck).not.toHaveBeenCalled();
    expect(pickYesNo).not.toHaveBeenCalled();
  });

  it('gives a muted Acolyte the apprentice meter, and a muted Knight none', async () => {
    getApprenticeProgress.mockResolvedValue({ answered: 4, graded: 4, accuracy: 0.75 });
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 5, smites: 0, maxSmites: 3 });
    expect((await run()).apprenticeMeter).toMatchObject({ accuracy: 0.75, answered: 4 });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 25, smites: 0, maxSmites: 3 });
    expect((await run()).apprenticeMeter).toBeNull();
  });

  it('marks an unmuted player as not muted', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: false });
    getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5, smites: 0, maxSmites: 3 });
    expect(await run()).toMatchObject({ muted: false, item: { src: 'k' } });
    expect(getFeed).toHaveBeenCalled();
  });
});
