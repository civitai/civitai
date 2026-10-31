import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { ratingDisputesSectionFor } = await import('../tickets/rating-disputes');

const disputesOf = vi.fn();
const reads = { disputesOf: (...a: unknown[]) => disputesOf(...a) } as never;

const dispute = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  entityType: 'Post',
  entityId: 900 + id,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  resolvedAt: null,
  status: 'Pending',
  currentLevel: 8,
  suggestedLevel: 4,
  appliedLevel: null,
  userComment: 'this is PG',
  modComment: null,
  user: { id: 7, username: 'u', image: null },
  resolver: null,
  entity: { id: 900 + id, title: 'A post', path: '/posts/1', nsfwLevel: 8, override: null },
  scan: null,
  levelOptions: [1, 4, 8],
  ...over,
});

beforeEach(() => disputesOf.mockReset().mockResolvedValue([dispute(1)]));

describe('ratingDisputesSectionFor', () => {
  it('lists the linked user’s disputes with what a ruling needs, asking for one row over the cap', async () => {
    const res = await ratingDisputesSectionFor({ userId: 7 }, reads);
    expect(disputesOf).toHaveBeenCalledWith(7, 11);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      truncated: false,
      disputes: [
        {
          id: 1,
          entityType: 'Post',
          entityId: 901,
          title: 'A post',
          path: '/posts/1',
          entityExists: true,
          status: 'Pending',
          currentLevel: 8,
          suggestedLevel: 4,
          appliedLevel: null,
          userComment: 'this is PG',
          modComment: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          resolvedAt: null,
          levelOptions: [1, 4, 8],
          rulable: true,
        },
      ],
    });
  });

  it('offers a ruling only for a pending dispute, and marks a deleted entity', async () => {
    disputesOf.mockResolvedValue([
      dispute(2, {
        status: 'Actioned',
        resolvedAt: new Date('2026-10-02T00:00:00Z'),
        entity: null,
      }),
    ]);
    const res = (await ratingDisputesSectionFor({ userId: 7 }, reads)) as never as {
      disputes: { rulable: boolean; entityExists: boolean; title: string | null }[];
    };
    expect(res.disputes[0]).toMatchObject({ rulable: false, entityExists: false, title: null });
  });

  it('cuts to the cap and says so', async () => {
    disputesOf.mockResolvedValue(Array.from({ length: 11 }, (_, i) => dispute(i + 1)));
    const res = (await ratingDisputesSectionFor({ userId: 7 }, reads)) as never as {
      disputes: unknown[];
      truncated: boolean;
    };
    expect(res.disputes).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });
});
