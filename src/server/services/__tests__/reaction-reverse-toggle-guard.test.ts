import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';

type Row = Record<string, unknown>;

const matches = (where: Row) => (row: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

// One table behind both the replica and the primary, so each toggle sees the last one's write.
function makeTable(rows: Row[] = []) {
  return {
    rows,
    findFirst: vi.fn(async ({ where }: { where: Row }) => rows.find(matches(where)) ?? null),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = rows.filter((row) => !matches(where)(row));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      rows.push(data);
      return data;
    }),
  };
}

const { mockOnCreated, mockOnRemoved } = vi.hoisted(() => ({
  mockOnCreated: vi.fn(async () => undefined),
  mockOnRemoved: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => dbMock.dbWrite }));
vi.mock('~/server/metrics', () => {
  const metrics = { queueUpdate: vi.fn(async () => undefined) };
  return {
    answerMetrics: metrics,
    articleMetrics: metrics,
    bountyEntryMetrics: metrics,
    postMetrics: metrics,
    questionMetrics: metrics,
  };
});
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
}));
vi.mock('~/server/events/points/hooks', () => ({
  onReactionCreated: mockOnCreated,
  onReactionRemoved: mockOnRemoved,
}));

import { toggleReaction } from '~/server/services/reaction.service';

const db = dbMock.dbWrite as unknown as Record<string, ReturnType<typeof makeTable>>;
const like = { entityType: 'image', entityId: 1, userId: 5, reaction: 'Like' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  installFakeCacheRedis();
  db.imageReaction = makeTable();
  db.commentReaction = makeTable();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toggleReaction — a reverse toggle inside the window is ignored', () => {
  it('like then unlike 100 ms later: the unlike is ignored and the like stands', async () => {
    expect(await toggleReaction(like)).toBe('created');
    vi.advanceTimersByTime(100);

    expect(await toggleReaction(like)).toBe('ignored');
    expect(db.imageReaction.rows).toHaveLength(1);
    expect(db.imageReaction.deleteMany).not.toHaveBeenCalled();
    expect(mockOnRemoved).not.toHaveBeenCalled();
  });

  it('unlike then relike 100 ms later: the relike is ignored and the unlike stands', async () => {
    db.imageReaction.rows.push({ imageId: 1, userId: 5, reaction: 'Like' });

    expect(await toggleReaction(like)).toBe('removed');
    vi.advanceTimersByTime(100);

    expect(await toggleReaction(like)).toBe('ignored');
    expect(db.imageReaction.rows).toHaveLength(0);
    expect(db.imageReaction.create).not.toHaveBeenCalled();
    expect(mockOnCreated).not.toHaveBeenCalled();
  });

  it('covers comment v1 (commentOld) the same way', async () => {
    const comment = { ...like, entityType: 'commentOld' } as const;
    expect(await toggleReaction(comment)).toBe('created');
    vi.advanceTimersByTime(100);

    expect(await toggleReaction(comment)).toBe('ignored');
    expect(db.commentReaction.rows).toHaveLength(1);
  });
});

describe('toggleReaction — toggles the guard must not touch', () => {
  it('a reverse toggle 200 ms later still counts', async () => {
    expect(await toggleReaction(like)).toBe('created');
    vi.advanceTimersByTime(200);

    expect(await toggleReaction(like)).toBe('removed');
    expect(db.imageReaction.rows).toHaveLength(0);
  });

  it('a different reaction on the same image inside the window still counts', async () => {
    expect(await toggleReaction(like)).toBe('created');
    vi.advanceTimersByTime(50);

    expect(await toggleReaction({ ...like, reaction: 'Heart' })).toBe('created');
    expect(db.imageReaction.rows).toHaveLength(2);
  });

  it('the same reaction on a different image inside the window still counts', async () => {
    expect(await toggleReaction(like)).toBe('created');
    vi.advanceTimersByTime(50);

    expect(await toggleReaction({ ...like, entityId: 2 })).toBe('created');
    expect(db.imageReaction.rows).toHaveLength(2);
  });

  it('another user on the same image inside the window still counts', async () => {
    expect(await toggleReaction(like)).toBe('created');
    vi.advanceTimersByTime(50);

    expect(await toggleReaction({ ...like, userId: 6 })).toBe('created');
    expect(db.imageReaction.rows).toHaveLength(2);
  });
});

describe('toggleReaction — Redis unavailable fails open', () => {
  it('toggles normally when the guard write throws', async () => {
    redisMock.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await toggleReaction(like)).toBe('created');
    expect(await toggleReaction(like)).toBe('removed');
  });

  it('toggles normally when the guard write never answers', async () => {
    redisMock.redis.set.mockImplementation(() => new Promise(() => undefined));

    const pending = toggleReaction(like);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe('created');
    expect(db.imageReaction.rows).toHaveLength(1);
  });
});
