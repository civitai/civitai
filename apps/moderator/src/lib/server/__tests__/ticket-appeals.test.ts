import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { appealsSectionFor } = await import('../tickets/appeals');

const appealsOf = vi.fn();
const imagesOfPosts = vi.fn();
const reads = { appealsOf, imagesOfPosts };
const all = () => true;

const base = {
  id: 1,
  entityType: 'Image',
  entityId: 100,
  status: 'Pending',
  createdAt: new Date('2026-10-20T00:00:00Z'),
  resolvedAt: null as Date | null,
  resolvedReason: null as string | null,
  resolvedMessage: null as string | null,
  entityRemovedAt: null as Date | null,
  category: null as string | null,
};

const ticket = (over: Record<string, unknown> = {}) => ({
  userId: 7,
  text: '',
  canRead: all,
  now: new Date('2026-10-29T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  appealsOf.mockReset().mockResolvedValue([]);
  imagesOfPosts.mockReset().mockResolvedValue([]);
});

describe('appealsSectionFor', () => {
  it('reads the linked user in one query over pending plus the last 30 days, bounded', async () => {
    await appealsSectionFor(ticket(), reads);
    expect(appealsOf).toHaveBeenCalledTimes(1);
    const [userId, since, limit] = appealsOf.mock.calls[0];
    expect(userId).toBe(7);
    expect((since as Date).toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(limit).toBeGreaterThan(25);
  });

  it('classifies each row once and keeps the order it was given', async () => {
    appealsOf.mockResolvedValue([
      { ...base, id: 5, entityRemovedAt: new Date('2026-10-02T00:00:00Z') },
      { ...base, id: 4, entityType: 'Model', category: 'Model' },
      { ...base, id: 3, entityType: 'Model' },
      { ...base, id: 2 },
    ]);
    const res = await appealsSectionFor(ticket(), reads);
    expect(res).toMatchObject({ status: 'ok', userId: 7 });
    expect(res.status === 'ok' && res.appeals.map((a) => [a.id, a.kind])).toEqual([
      [5, 'removed'],
      [4, 'site'],
      [3, 'modelFlag'],
      [2, 'image'],
    ]);
  });

  it('shows only the types whose queue grant the viewer holds', async () => {
    appealsOf.mockResolvedValue([
      { ...base, id: 3, entityType: 'Model' },
      { ...base, id: 2 },
      { ...base, id: 4, entityType: 'Article', category: 'Article' },
    ]);
    const canRead = (p: string) => p === '/images/appeals' || p === '/appeals/articles';
    const res = await appealsSectionFor(ticket({ canRead }), reads);
    expect(res.status === 'ok' && res.appeals.map((a) => a.id)).toEqual([2, 4]);
  });

  it('offers a ruling only on a pending image appeal', async () => {
    appealsOf.mockResolvedValue([
      { ...base, id: 1 },
      { ...base, id: 2, status: 'Approved' },
      { ...base, id: 3, entityType: 'Model' },
      { ...base, id: 4, entityRemovedAt: new Date('2026-10-02T00:00:00Z') },
      { ...base, id: 5, category: 'Other' },
    ]);
    const res = await appealsSectionFor(ticket(), reads);
    expect(res.status === 'ok' && res.appeals.map((a) => [a.id, a.rulable])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
  });

  it('carries the decision of a decided appeal', async () => {
    appealsOf.mockResolvedValue([
      {
        ...base,
        status: 'Rejected',
        resolvedAt: new Date('2026-10-25T00:00:00Z'),
        resolvedReason: 'Violates TOS',
        resolvedMessage: 'Sorry',
      },
    ]);
    const res = await appealsSectionFor(ticket(), reads);
    expect(res.status === 'ok' && res.appeals[0]).toMatchObject({
      status: 'Rejected',
      resolvedAt: '2026-10-25T00:00:00.000Z',
      resolvedReason: 'Violates TOS',
      resolvedMessage: 'Sorry',
      createdAt: '2026-10-20T00:00:00.000Z',
    });
  });

  it('marks an appeal whose image, model or post-image the ticket links', async () => {
    appealsOf.mockResolvedValue([
      { ...base, id: 1, entityId: 100 },
      { ...base, id: 2, entityId: 200 },
      { ...base, id: 3, entityId: 300 },
      { ...base, id: 4, entityType: 'Model', entityId: 9 },
      { ...base, id: 5, entityType: 'Model', entityId: 10 },
    ]);
    imagesOfPosts.mockResolvedValue([{ id: 200, postId: 55 }]);
    const text = 'civitai.com/images/100 https://civitai.com/posts/55 civitai.red/models/9';
    const res = await appealsSectionFor(ticket({ text }), reads);
    expect(res.status === 'ok' && res.appeals.map((a) => [a.id, a.mentioned])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, true],
      [5, false],
    ]);
    expect(imagesOfPosts).toHaveBeenCalledWith([55], [100, 200, 300]);
  });

  it('does not look up posts when the ticket links none', async () => {
    appealsOf.mockResolvedValue([base]);
    await appealsSectionFor(ticket({ text: 'civitai.com/images/100' }), reads);
    expect(imagesOfPosts).not.toHaveBeenCalled();
  });

  it('still lists the appeals when the post lookup fails', async () => {
    appealsOf.mockResolvedValue([base]);
    imagesOfPosts.mockRejectedValue(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appealsSectionFor(ticket({ text: 'civitai.com/posts/5' }), reads);
    expect(res).toMatchObject({ status: 'ok' });
  });

  it('cuts the list at 25 and says it did', async () => {
    appealsOf.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ ...base, id: i + 1 })));
    const res = await appealsSectionFor(ticket(), reads);
    expect(res.status === 'ok' && res.appeals).toHaveLength(25);
    expect(res).toMatchObject({ truncated: true });
  });

  it('says the list is cut when the read itself was full, even if the grants hide most of it', async () => {
    await appealsSectionFor(ticket(), reads);
    const limit = appealsOf.mock.calls[0][2] as number;
    appealsOf.mockResolvedValue(
      Array.from({ length: limit }, (_, i) => ({
        ...base,
        id: i + 1,
        entityType: 'Model',
      }))
    );
    const canRead = (p: string) => p === '/images/appeals';
    const res = await appealsSectionFor(ticket({ canRead }), reads);
    expect(res.status === 'ok' && res.appeals).toHaveLength(0);
    expect(res).toMatchObject({ truncated: true });
  });
});
