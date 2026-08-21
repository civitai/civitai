import { describe, expect, it, vi } from 'vitest';
import { placementDetailFetcher } from '~/server/notifications/detail-fetchers/placement.detail-fetcher';
import { placementNotifications } from '~/server/notifications/placement.notifications';

const fakeDb = (users: { id: number; username: string }[]) => {
  const findMany = vi.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
    users.filter((u) => where.id.in.includes(u.id))
  );

  return { db: { user: { findMany } } as never, findMany };
};

const notification = (type: string, details: Record<string, unknown>) => ({
  id: 1,
  type,
  details,
});

describe('the avatar on a placement notification', () => {
  // The row falls back to a generic bell without this, which is what every
  // placement notification did before the fetcher existed.
  it('names the placer on a notification addressed to the owner', async () => {
    const { db } = fakeDb([{ id: 20, username: 'demiandei' }]);
    const rows = [notification('sticker-placement-pending', { placerId: 20, imageId: 99 })];

    await placementDetailFetcher.fetcher(rows, { db });

    expect(rows[0].details.actor).toMatchObject({ id: 20, username: 'demiandei' });
  });

  it('names the owner on a notification addressed to the placer', async () => {
    const { db } = fakeDb([{ id: 10, username: 'boerboer' }]);
    const rows = [notification('sticker-placement-resolved', { ownerId: 10, imageId: 99 })];

    await placementDetailFetcher.fetcher(rows, { db });

    expect(rows[0].details.actor).toMatchObject({ id: 10, username: 'boerboer' });
  });

  // One query for the panel, not one per row — the whole reason this runs as a
  // fetcher over the page rather than per notification.
  it('asks for each user once across the page', async () => {
    const { db, findMany } = fakeDb([
      { id: 20, username: 'demiandei' },
      { id: 10, username: 'boerboer' },
    ]);
    const rows = [
      notification('sticker-placement-pending', { placerId: 20 }),
      notification('sticker-placement-pending', { placerId: 20 }),
      notification('sticker-placement-resolved', { ownerId: 10 }),
    ];

    await placementDetailFetcher.fetcher(rows, { db });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toEqual([20, 10]);
  });

  it('queries nothing when no row names anyone', async () => {
    const { db, findMany } = fakeDb([{ id: 20, username: 'demiandei' }]);
    const rows = [notification('sticker-placement-pending', { imageId: 99 })];

    await placementDetailFetcher.fetcher(rows, { db });

    expect(findMany).not.toHaveBeenCalled();
    expect(rows[0].details.actor).toBeUndefined();
  });

  it('leaves the row alone when the user no longer exists', async () => {
    const { db } = fakeDb([]);
    const rows = [notification('sticker-placement-pending', { placerId: 20 })];

    await placementDetailFetcher.fetcher(rows, { db });

    expect(rows[0].details.actor).toBeUndefined();
  });

  // Registered against the processor's own keys, so a placement type added later
  // is covered without being listed here a second time.
  it('covers every placement notification type', () => {
    expect(placementDetailFetcher.types.sort()).toEqual(Object.keys(placementNotifications).sort());
    expect(placementDetailFetcher.types.length).toBeGreaterThan(1);
  });

  /**
   * The coalesce above picks the placer whenever both ids are present, which is
   * only the right person because no processor writes both. That is a property
   * of the QUERIES, not of this fetcher, and the coverage test cannot see it: a
   * new type auto-enrols and a changed details shape renders the reader their
   * own avatar with every other assertion green.
   *
   * Fails closed — a type whose query emits neither id fails here rather than
   * passing for want of a match.
   */
  it('has exactly one party to name in every processor', async () => {
    const emitted = await Promise.all(
      Object.entries(placementNotifications).map(async ([type, processor]) => {
        const query = await processor.prepareQuery?.({
          lastSent: '2026-01-01',
          category: 'Creator',
        } as never);

        return {
          type,
          ids: (["'placerId'", "'ownerId'"] as const).filter((id) => String(query).includes(id)),
        };
      })
    );

    expect(emitted.length).toBe(Object.keys(placementNotifications).length);
    for (const { type, ids } of emitted) expect([type, ids]).toEqual([type, [expect.any(String)]]);
  });
});
