import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memorySkipStore } from '$lib/server/skips';

const store = vi.hoisted(() => ({ current: undefined as unknown }));
const castVote = vi.hoisted(() => vi.fn());
const answerHiddenCheck = vi.hoisted(() => vi.fn());
const castYesNoVote = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const voteRefused = vi.hoisted(() => vi.fn());
const recordUnsure = vi.hoisted(() => vi.fn());
const reportYesNo = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/metrics', async (original) => {
  const real = await original<typeof import('$lib/server/metrics')>();
  return { ...real, metrics: { ...real.metrics, voteRefused } };
});
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/skip-runtime', () => ({
  get skipStore() {
    return store.current;
  },
}));
vi.mock('$lib/server/db', () => ({ db: {}, dbRead: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  hiddenItemId: (id: number) => -id,
  answerHiddenCheck,
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote }));
vi.mock('$lib/server/yesno/unsure', () => ({ recordUnsure }));
vi.mock('$lib/server/yesno/report', () => ({ reportYesNo }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({
  yesNoConfig: () => ({ share: 0, stretch: 8 }),
  reportDeps: vi.fn(),
}));

const { sealItem } = await import('$lib/server/feed-token');
const { skippedFor } = await import('$lib/server/skips');
const { actions } = await import('./+page.server');

const skip = (item: string, userId = 7, extra: Record<string, string> = {}) => {
  const body = new FormData();
  body.set('item', item);
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  return actions.skip({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: userId } },
  } as never);
};

beforeEach(() => {
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  store.current = memorySkipStore();
  castVote.mockReset();
  answerHiddenCheck.mockReset();
  castYesNoVote.mockReset();
  voteRefused.mockReset();
  recordUnsure.mockReset();
  recordUnsure.mockResolvedValue(true);
  reportYesNo.mockReset();
  reportYesNo.mockResolvedValue({ recorded: true, pulled: false, pulledImage: null });
});

describe('skip refusals', () => {
  it('records a muted player and a token that does not open, as skips', async () => {
    getStanding.mockResolvedValueOnce({ banned: false, muted: true });
    await skip(sealItem('secret', 7, { kind: 'queue', id: 3 }));
    await skip('not-a-token');

    expect(voteRefused).toHaveBeenNthCalledWith(1, 'muted', 'unknown', 7, null, 'skip');
    expect(voteRefused).toHaveBeenNthCalledWith(2, 'bad-token', 'unknown', 7, null, 'skip');
  });
});

describe('skip action', () => {
  it.each(['queue', 'hidden', 'yesno'] as const)(
    'remembers a skipped %s item for that player without judging it',
    async (kind) => {
      expect(await skip(sealItem('secret', 7, { kind, id: 12 }))).toEqual({ success: true });

      expect((await skippedFor(store.current as never, 7))[kind]).toEqual([12]);
      expect(await skippedFor(store.current as never, 8)).toEqual({
        queue: [],
        hidden: [],
        yesno: [],
      });
      expect(castVote).not.toHaveBeenCalled();
      expect(answerHiddenCheck).not.toHaveBeenCalled();
      expect(castYesNoVote).not.toHaveBeenCalled();
    }
  );

  it('answers every kind of item the same way, so a skip shows nothing about it', async () => {
    const results = await Promise.all(
      (['queue', 'hidden', 'yesno'] as const).map((kind) =>
        skip(sealItem('secret', 7, { kind, id: 1 }))
      )
    );
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('records a Not sure for the question when the skipped item is a yes/no question, and only then', async () => {
    await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }));
    expect(recordUnsure).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      playerId: 7,
      itemId: 12,
      now: new Date('2026-12-15T12:00:00Z'),
    });

    recordUnsure.mockClear();
    await skip(sealItem('secret', 7, { kind: 'queue', id: 13 }));
    await skip(sealItem('secret', 7, { kind: 'hidden', id: 14 }));
    expect(recordUnsure).not.toHaveBeenCalled();
  });

  it('records no Not sure when the player only dismissed a question other players settled, and still moves them on', async () => {
    expect(await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, { settled: '1' })).toEqual({
      success: true,
    });
    expect(recordUnsure).not.toHaveBeenCalled();
    expect((await skippedFor(store.current as never, 7)).yesno).toEqual([12]);
  });

  it('answers a yes/no skip the same whether or not the Not sure was stored', async () => {
    recordUnsure.mockResolvedValue(false);
    expect(await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }))).toEqual({ success: true });
  });

  it('records no Not sure for a token that does not open, or for a muted player', async () => {
    await skip('nonsense');
    getStanding.mockResolvedValueOnce({ banned: false, muted: true });
    await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }));
    expect(recordUnsure).not.toHaveBeenCalled();
  });

  it('refuses a token that is forged or belongs to another player', async () => {
    expect(await skip('nonsense')).toMatchObject({ status: 400 });
    expect(await skip(sealItem('secret', 8, { kind: 'queue', id: 1 }))).toMatchObject({
      status: 400,
    });
    expect(await skippedFor(store.current as never, 7)).toEqual({
      queue: [],
      hidden: [],
      yesno: [],
    });
  });

  it('still moves the player on when the skip cannot be remembered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.current = {
      add: async () => {
        throw new Error('down');
      },
      list: async () => [],
    };
    expect(await skip(sealItem('secret', 7, { kind: 'queue', id: 1 }))).toEqual({ success: true });
  });
});

describe('a report, posted on the skip', () => {
  const NOW = new Date('2026-12-15T12:00:00Z');

  it.each(['image', 'question'] as const)(
    'records a %s report on a yes/no question instead of a Not sure, and moves the player on',
    async (reason) => {
      expect(
        await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, { report: reason })
      ).toEqual({ success: true });

      expect(reportYesNo).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        { playerId: 7, itemId: 12, reason, now: NOW },
        expect.any(Function)
      );
      expect(recordUnsure).not.toHaveBeenCalled();
      expect((await skippedFor(store.current as never, 7)).yesno).toEqual([12]);
    }
  );

  it('answers the same for every kind of item, and records a report on a yes/no question only', async () => {
    const results = await Promise.all(
      (['queue', 'hidden', 'yesno'] as const).map((kind) =>
        skip(sealItem('secret', 7, { kind, id: 1 }), 7, { report: 'image' })
      )
    );
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ success: true });
    expect(reportYesNo).toHaveBeenCalledTimes(1);
  });

  it('answers the same whether the report pulled the question or was not stored', async () => {
    reportYesNo.mockResolvedValueOnce({ recorded: true, pulled: true, pulledImage: 5 });
    const pulled = await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, {
      report: 'image',
    });
    reportYesNo.mockResolvedValueOnce({ recorded: false, pulled: false, pulledImage: null });
    const repeat = await skip(sealItem('secret', 7, { kind: 'yesno', id: 13 }), 7, {
      report: 'image',
    });
    expect(pulled).toEqual(repeat);
  });

  it('takes an unknown reason as a Not sure', async () => {
    await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, { report: 'spam' });
    expect(reportYesNo).not.toHaveBeenCalled();
    expect(recordUnsure).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a muted player or on dismissing a settled question', async () => {
    getStanding.mockResolvedValueOnce({ banned: false, muted: true });
    expect(
      await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, { report: 'image' })
    ).toMatchObject({ status: 403 });
    await skip(sealItem('secret', 7, { kind: 'yesno', id: 12 }), 7, {
      report: 'image',
      settled: '1',
    });
    expect(reportYesNo).not.toHaveBeenCalled();
  });
});

describe('skip action for a muted player', () => {
  it('refuses with a friendly 403 and remembers nothing', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await skip(sealItem('secret', 7, { kind: 'queue', id: 12 }))).toMatchObject({
      status: 403,
      data: { message: expect.stringMatching(/muted/i) },
    });
    expect(await skippedFor(store.current as never, 7)).toEqual({
      queue: [],
      hidden: [],
      yesno: [],
    });
  });
});
