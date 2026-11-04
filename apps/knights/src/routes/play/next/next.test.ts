import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const pickHiddenCheck = vi.hoisted(() => vi.fn());
const pickYesNo = vi.hoisted(() => vi.fn());
const voteLockUntil = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const queueDeps = vi.hoisted(() => ({
  now: () => new Date('2026-12-15T12:00:00Z'),
  voteLimits: undefined as unknown,
}));
const skipList = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn() }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => `cdn/${key}` }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps }));
vi.mock('$lib/server/queue/vote-rate', () => ({ voteLockUntil }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/skip-runtime', () => ({ skipStore: skipList }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 0.5 }) }));
vi.mock('$lib/server/hidden/hidden.service', () => ({ pickHiddenCheck }));
vi.mock('$lib/server/queue/queue.service', () => ({ getFeed }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0.5, stretch: 8 }) }));
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));

const { sealItem, openItem } = await import('$lib/server/feed-token');
const { GET } = await import('./+server');

const token = (kind: 'queue' | 'hidden' | 'yesno', id: number) =>
  sealItem('secret', 7, { kind, id });

const ask = async (after: string[], user: Record<string, unknown> = {}) => {
  const url = new URL('http://knights.test/play/next');
  for (const value of after) url.searchParams.append('after', value);
  const response = await GET({ url, locals: { user: { id: 7, ...user } } } as never);
  return { response, body: (await response.json()) as Record<string, any> };
};

const feed = {
  question: { key: 'q', kind: 'rating', prompt: 'Rate it', options: [] },
  items: [{ id: 42, imageKey: 'k42', width: 10, height: 20 }],
};

beforeEach(() => {
  for (const mock of [
    getPlayerStatus,
    getFeed,
    pickHiddenCheck,
    pickYesNo,
    voteLockUntil,
    skipList.list,
    getStanding,
  ]) {
    mock.mockReset();
  }
  getPlayerStatus.mockResolvedValue({ rank: 'Knight', level: 5, smites: 0, maxSmites: 3 });
  getStanding.mockResolvedValue({ banned: false, muted: false });
  getFeed.mockResolvedValue(feed);
  pickHiddenCheck.mockResolvedValue(null);
  pickYesNo.mockResolvedValue(null);
  skipList.list.mockResolvedValue([]);
  queueDeps.voteLimits = undefined;
});

describe('GET /play/next', () => {
  it('serves the item after the ones named, sealed for this player, never cached', async () => {
    const { response, body } = await ask([token('queue', 9)]);

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.next).toMatchObject({
      question: { key: 'q' },
      item: { src: 'cdn/k42', width: 10, height: 20 },
    });
    expect(openItem('secret', 7, body.next.item.id)).toEqual({ kind: 'queue', id: 42 });
  });

  it('leaves out every named item, by kind, and rolls from them instead of from the last vote', async () => {
    skipList.list.mockResolvedValue([{ kind: 'queue', id: 1 }]);
    await ask([token('queue', 9), token('hidden', 5), token('yesno', 3)]);

    expect(getFeed).toHaveBeenCalledWith({}, 7, { limit: 1, exclude: [1, 9] });
    const hidden = pickHiddenCheck.mock.calls[0][1];
    expect(hidden.exclude).toEqual([5]);
    expect(pickYesNo.mock.calls[0][1].exclude).toEqual([3]);
    expect(typeof hidden.slot).toBe('number');
    expect(pickYesNo.mock.calls[0][1].slot).toBe(hidden.slot);
  });

  it('rolls the same for the same items, so asking again cannot reroll', async () => {
    await ask([token('queue', 9)]);
    await ask([token('queue', 9)]);
    expect(pickHiddenCheck.mock.calls[0][1].slot).toBe(pickHiddenCheck.mock.calls[1][1].slot);
  });

  it("ignores tokens that are not this player's, and caps how many it reads", async () => {
    const stranger = sealItem('secret', 8, { kind: 'queue', id: 77 });
    await ask([stranger, 'garbage']);
    expect(getFeed).toHaveBeenCalledWith({}, 7, { limit: 1, exclude: [] });
  });

  it('serves a hidden check or a yes/no item as the next one when the roll picks it', async () => {
    pickHiddenCheck.mockResolvedValue({
      referenceId: 5,
      imageKey: 'h5',
      width: 1,
      height: 2,
      question: { key: 'q', kind: 'rating', prompt: 'Rate it', options: [] },
    });
    const { body } = await ask([token('queue', 9)]);
    expect(openItem('secret', 7, body.next.item.id)).toEqual({ kind: 'hidden', id: 5 });
  });

  it.each([
    ['muted', () => getStanding.mockResolvedValue({ banned: false, muted: true })],
    [
      'reset-pending',
      () => getPlayerStatus.mockResolvedValue({ rank: 'Knight', smites: 3, maxSmites: 3 }),
    ],
    [
      'paced',
      () => {
        queueDeps.voteLimits = {};
        voteLockUntil.mockResolvedValue(new Date('2026-12-15T12:05:00Z'));
      },
    ],
  ])(
    'serves nothing while the player is %s, so the page falls back to the real feed',
    async (_name, arrange) => {
      arrange();
      const { body } = await ask([token('queue', 9)]);
      expect(body.next).toBeNull();
      expect(getFeed).not.toHaveBeenCalled();
    }
  );

  it('serves nothing when the queue is empty', async () => {
    getFeed.mockResolvedValue(null);
    expect((await ask([])).body.next).toBeNull();
  });

  it('serves nothing to an Acolyte, whose practice has its own flow', async () => {
    getPlayerStatus.mockResolvedValue({ rank: 'Acolyte', smites: 0, maxSmites: 3 });
    expect((await ask([token('queue', 9)])).body.next).toBeNull();
    expect(getFeed).not.toHaveBeenCalled();
  });
});
