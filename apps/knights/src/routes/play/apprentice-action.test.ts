import { beforeEach, describe, expect, it, vi } from 'vitest';

const answerApprentice = vi.hoisted(() => vi.fn());
const acknowledgeCheckpoint = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));
vi.mock('$lib/server/apprenticeship/runtime', () => ({
  apprenticeDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/apprenticeship/apprenticeship.service', () => ({
  answerApprentice,
  acknowledgeCheckpoint,
  getApprentice: vi.fn(),
}));

const getPlayerStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/player-status', async (original) => ({
  ...(await original<typeof import('$lib/server/player-status')>()),
  getPlayerStatus,
}));
const seen = vi.hoisted(() => ({
  store: null as null | import('$lib/server/seen').SeenStore,
}));
vi.mock('$lib/server/seen-runtime', () => ({
  seenStore: {
    get: (userId: number) => seen.store!.get(userId),
    set: (userId: number, value: import('$lib/server/seen').Seen) => seen.store!.set(userId, value),
  },
}));

const { memorySeenStore } = await import('$lib/server/seen');
const { actions } = await import('./+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.apprentice({
    request: new Request('http://x', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never) as Promise<Record<string, unknown>>;
};
const valid = { kind: 'rating', referenceId: '5', answer: '4' };

beforeEach(() => {
  seen.store = memorySeenStore();
  getPlayerStatus.mockReset();
  getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 5 });
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  answerApprentice.mockReset();
  acknowledgeCheckpoint.mockReset();
});

describe('apprentice action', () => {
  it('answers with only whether it was right, and whether the player was knighted', async () => {
    answerApprentice.mockResolvedValue({
      status: 'recorded',
      correct: false,
      xp: 0,
      promoted: false,
    });

    expect(await post(valid)).toEqual({ success: true, correct: false, promoted: false });
    expect(answerApprentice).toHaveBeenCalledWith(
      {},
      { userId: 7, kind: 'rating', referenceId: 5, version: null, answer: '4' },
      expect.anything()
    );
  });

  it('hands the version the item was served with to the ledger', async () => {
    answerApprentice.mockResolvedValue({ status: 'rejected', reason: 'not-current' });

    await post({ kind: 'yesno', referenceId: '5', version: '2026-12-15 12:00:00', answer: 'yes' });

    expect(answerApprentice).toHaveBeenCalledWith(
      {},
      { userId: 7, kind: 'yesno', referenceId: 5, version: '2026-12-15 12:00:00', answer: 'yes' },
      expect.anything()
    );
  });

  it('turns a refused answer into a 409 the page can show', async () => {
    answerApprentice.mockResolvedValue({ status: 'rejected', reason: 'checkpoint-pending' });
    expect(await post(valid)).toMatchObject({ status: 409 });
  });

  it('refuses a malformed submission before touching the ledger', async () => {
    expect(await post({ ...valid, kind: 'other' })).toMatchObject({ status: 400 });
    expect(await post({ ...valid, referenceId: 'x' })).toMatchObject({ status: 400 });
    expect(answerApprentice).not.toHaveBeenCalled();
  });

  it('answers 500 rather than a verdict when the ledger throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answerApprentice.mockRejectedValue(new Error('down'));
    expect(await post(valid)).toMatchObject({ status: 500 });
  });

  it('moves past a checkpoint for the signed-in player', async () => {
    const result = await actions.continueCheckpoint({
      request: new Request('http://x', { method: 'POST', body: new FormData() }),
      locals: { user: { id: 7 } },
    } as never);
    expect(result).toEqual({ success: true });
    expect(acknowledgeCheckpoint).toHaveBeenCalledWith({}, 7, expect.any(Date));
  });

  it('keeps the player on the recap with a 500 when the checkpoint cannot be stamped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    acknowledgeCheckpoint.mockRejectedValueOnce(new Error('down'));
    const result = await actions.continueCheckpoint({
      request: new Request('http://x', { method: 'POST', body: new FormData() }),
      locals: { user: { id: 7 } },
    } as never);
    expect(result).toMatchObject({ status: 500 });
  });
});

describe('apprentice action for a muted player', () => {
  it('refuses with a friendly 403 and records no answer', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await post(valid)).toMatchObject({
      status: 403,
      data: { message: expect.stringMatching(/muted/i) },
    });
    expect(answerApprentice).not.toHaveBeenCalled();
  });

  it('lets a player who is not muted answer', async () => {
    answerApprentice.mockResolvedValue({
      status: 'recorded',
      correct: true,
      xp: 1,
      promoted: false,
    });
    expect(await post(valid)).toMatchObject({ success: true });
  });
});

describe('the milestone card lasts for the item it appeared with', () => {
  const recorded = { status: 'recorded', correct: true, xp: 100, promoted: false };
  const continuePast = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return actions.continueCheckpoint({
      request: new Request('http://x', { method: 'POST', body }),
      locals: { user: { id: 7 } },
    } as never);
  };

  beforeEach(async () => {
    await seen.store!.set(7, { rank: 'Acolyte', level: 4, guide: true });
  });

  it('an answer given with the milestone card on screen records that standing as seen', async () => {
    // The answer itself takes the player to level 6; the card showed level 5.
    answerApprentice.mockImplementation(async () => {
      getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', level: 6 });
      return recorded;
    });

    expect(await post({ ...valid, noticeShown: '1' })).toMatchObject({ success: true });
    expect(await seen.store!.get(7)).toEqual({ rank: 'Acolyte', level: 5, guide: true });
  });

  it('an answer with no card showing records nothing', async () => {
    answerApprentice.mockResolvedValue(recorded);

    await post(valid);
    expect(await seen.store!.get(7)).toEqual({ rank: 'Acolyte', level: 4, guide: true });
  });

  it('continuing past the recap with the card on screen records it', async () => {
    expect(await continuePast({ noticeShown: '1' })).toEqual({ success: true });
    expect(await seen.store!.get(7)).toEqual({ rank: 'Acolyte', level: 5, guide: true });

    await seen.store!.set(7, { rank: 'Acolyte', level: 4, guide: true });
    await continuePast({});
    expect(await seen.store!.get(7)).toEqual({ rank: 'Acolyte', level: 4, guide: true });
  });

  it('a seen store that is down still records the answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seen.store = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    answerApprentice.mockResolvedValue(recorded);

    expect(await post({ ...valid, noticeShown: '1' })).toEqual({
      success: true,
      correct: true,
      promoted: false,
    });
    expect(answerApprentice).toHaveBeenCalledOnce();
  });
});
