import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatus = vi.hoisted(() => vi.fn());
const getFeed = vi.hoisted(() => vi.fn());
const pickHiddenCheck = vi.hoisted(() => vi.fn());
const pickYesNo = vi.hoisted(() => vi.fn());
const lockoutFor = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const queueDeps = vi.hoisted(() => ({
  now: () => new Date('2026-12-15T12:00:00Z'),
}));
const skipList = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn() }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => `cdn/${key}` }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps }));
vi.mock('$lib/server/vote-limits/runtime', () => ({ lockoutFor }));
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
const { MAX_EXCLUDED } = await import('../optimistic');

const token = (kind: 'queue' | 'hidden' | 'yesno', id: number) =>
  sealItem('secret', 7, { kind, id });

const ask = async (
  after: string[],
  user: Record<string, unknown> = {},
  count?: number,
  ahead: string[] = []
) => {
  const url = new URL('http://knights.test/play/next');
  if (count !== undefined) url.searchParams.set('count', String(count));
  for (const value of after) url.searchParams.append('after', value);
  for (const value of ahead) url.searchParams.append('ahead', value);
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
    lockoutFor,
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
});

describe('GET /play/next', () => {
  it('gives each item a key that is stable across requests while its token is re-sealed', async () => {
    const first = await ask([token('queue', 9)]);
    const second = await ask([token('queue', 9)]);

    expect(first.body.next.item.id).not.toBe(second.body.next.item.id);
    expect(first.body.next.item.key).toBe('q:cdn/k42');
    expect(second.body.next.item.key).toBe(first.body.next.item.key);
    expect(first.body.next.item.key).not.toContain(first.body.next.item.id);
    expect(first.body.items[0].item.key).toBe(first.body.next.item.key);
  });

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

  it('tells the yes/no picker only the yes/no questions named as ahead, so the stretch counts them', async () => {
    await ask([], {}, undefined, [token('yesno', 3), token('queue', 9), token('yesno', 4)]);
    expect(pickYesNo.mock.calls[0][1].ahead).toEqual([3, 4]);
  });

  it('does not count a skipped or unloadable yes/no item named in after as ahead: it never gets a vote', async () => {
    skipList.list.mockResolvedValue([{ kind: 'yesno', id: 5 }]);
    await ask([token('yesno', 5), token('yesno', 6)], {}, undefined, [token('yesno', 5)]);
    expect(pickYesNo.mock.calls[0][1].ahead).toEqual([]);
    expect(pickYesNo.mock.calls[0][1].exclude).toEqual([5, 5, 6]);
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
        lockoutFor.mockResolvedValue(new Date('2026-12-15T12:05:00Z'));
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

  describe('with a count', () => {
    // A queue that hands out the first id not excluded, so each pick depends on the ones before it.
    const queueOfFive = (size = 5) =>
      getFeed.mockImplementation(async (_db, _user, options: { exclude?: number[] }) => {
        const id = Array.from({ length: size }, (_, i) => i + 1).find(
          (candidate) => !options.exclude?.includes(candidate)
        );
        return id === undefined
          ? null
          : { ...feed, items: [{ id, imageKey: `k${id}`, width: 1, height: 1 }] };
      });
    const ids = (body: Record<string, any>) =>
      body.items.map((entry: any) => openItem('secret', 7, entry.item.id)?.id);

    it('returns that many items in order, each picked as if the ones before it were judged', async () => {
      queueOfFive();
      const { body } = await ask([token('queue', 1)], {}, 3);
      expect(ids(body)).toEqual([2, 3, 4]);
      expect(body.next.item.id).toBe(body.items[0].item.id);
    });

    it('serves one item by default and never more than the buffer holds', async () => {
      queueOfFive();
      expect(ids((await ask([], {})).body)).toEqual([1]);
      expect(ids((await ask([], {}, -2)).body)).toEqual([1]);
    });

    it('serves up to 10 items in one request and no more', async () => {
      queueOfFive(30);
      expect(ids((await ask([], {}, 10)).body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(ids((await ask([], {}, 50)).body)).toHaveLength(10);
    });

    it('reads as many named items as a full buffer, the item on screen and the votes in flight', async () => {
      queueOfFive(60);
      const named = Array.from({ length: MAX_EXCLUDED }, (_, i) => token('queue', i + 1));
      const { body } = await ask([token('queue', 99), ...named], {}, 3);
      expect(ids(body)).toEqual([MAX_EXCLUDED + 1, MAX_EXCLUDED + 2, MAX_EXCLUDED + 3]);
      expect(getFeed.mock.calls[0][2].exclude).toEqual(
        Array.from({ length: MAX_EXCLUDED }, (_, i) => i + 1)
      );
    });

    it('serves fewer when the queue runs out, and nothing when it is empty', async () => {
      queueOfFive();
      expect(
        ids((await ask([token('queue', 1), token('queue', 2), token('queue', 3)], {}, 3)).body)
      ).toEqual([4, 5]);
      getFeed.mockResolvedValue(null);
      const { body } = await ask([], {}, 3);
      expect(body.items).toEqual([]);
      expect(body.next).toBeNull();
    });

    it('returns the same items for the same request, and rolls with a different slot at each position', async () => {
      queueOfFive();
      const first = await ask([token('queue', 1)], {}, 3);
      const slots = pickHiddenCheck.mock.calls.map((call) => call[1].slot);
      pickHiddenCheck.mockClear();
      const second = await ask([token('queue', 1)], {}, 3);

      expect(ids(second.body)).toEqual(ids(first.body));
      expect(pickHiddenCheck.mock.calls.map((call) => call[1].slot)).toEqual(slots);
      expect(new Set(slots).size).toBe(3);
    });

    it('leaves out what earlier items of the same response took, for every kind', async () => {
      queueOfFive();
      pickHiddenCheck.mockResolvedValueOnce({
        referenceId: 5,
        imageKey: 'h5',
        width: 1,
        height: 2,
        question: { key: 'q', kind: 'rating', prompt: 'Rate it', options: [] },
      });
      await ask([], {}, 2);
      expect(pickHiddenCheck.mock.calls[1][1].exclude).toEqual([5]);
      expect(getFeed.mock.calls[1][2].exclude).toEqual([]);
    });
  });
});
