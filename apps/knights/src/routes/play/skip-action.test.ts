import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memorySkipStore } from '$lib/server/skips';

const store = vi.hoisted(() => ({ current: undefined as unknown }));
const castVote = vi.hoisted(() => vi.fn());
const answerHiddenCheck = vi.hoisted(() => vi.fn());
const castYesNoVote = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/skip-runtime', () => ({
  get skipStore() {
    return store.current;
  },
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  answerHiddenCheck,
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));

const { sealItem } = await import('$lib/server/feed-token');
const { skippedFor } = await import('$lib/server/skips');
const { actions } = await import('./+page.server');

const skip = (item: string, userId = 7) => {
  const body = new FormData();
  body.set('item', item);
  return actions.skip({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: userId } },
  } as never);
};

beforeEach(() => {
  store.current = memorySkipStore();
  castVote.mockReset();
  answerHiddenCheck.mockReset();
  castYesNoVote.mockReset();
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

  it('refuses a token that is forged or belongs to another player', async () => {
    expect(await skip('nonsense')).toMatchObject({ status: 400 });
    expect(await skip(sealItem('secret', 8, { kind: 'queue', id: 1 }))).toMatchObject({
      status: 400,
    });
    expect(await skippedFor(store.current as never, 7)).toEqual({ queue: [], hidden: [], yesno: [] });
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
