import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  handleNotificationSignal,
  hasLoadedNotificationList,
  insertSignalledNotification,
  notificationListFilters,
} from '~/components/Notifications/notifications.utils';
import type { NotificationGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';

/**
 * A new-notification signal used to trigger a detail fetch in every open tab, whether or not that tab
 * had ever opened its notifications. The response is only ever written into a notification list that
 * is already loaded, so in a tab without one it was discarded: a request per signal, per tab, for
 * nothing.
 *
 * Keys are built with the real tRPC `getQueryKey`, the same call the panel's query makes, and a real
 * `QueryClient` does the matching — the question is what the cache says, not what a fixture assumes.
 */
const LIST_KEY = getQueryKey(trpc.notification.getAllByUser)[0];
/** The panel's own query: `useQueryNotifications({ limit: 30, category: selectedCategory, … })`. */
const panelKey = (category?: string) =>
  getQueryKey(trpc.notification.getAllByUser, { limit: 30, category } as never, 'infinite');

const page = (ids: number[]) => ({ items: ids.map((id) => ({ id })), nextCursor: undefined });
const loaded = (queryClient: QueryClient, category?: string, pages = [page([4])]) =>
  queryClient.setQueryData(panelKey(category), { pages, pageParams: pages.map(() => undefined) });

const SIGNALLED = {
  id: '2421362569',
  type: 'new-comment',
  category: 'Comment',
  details: { commentId: 731 },
  createdAt: '2026-10-12T16:00:00.000Z',
  read: false,
} as unknown as NotificationGetAllItem;

const filters = notificationListFilters(LIST_KEY, 'Comment');

const okFetch = () =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ id: '2421362569', details: { commentId: 731, content: 'hi' } }),
        {
          status: 200,
        }
      )
  );

const firstItems = (queryClient: QueryClient, category?: string) =>
  (queryClient.getQueryData(panelKey(category)) as { pages: { items: unknown[] }[] }).pages[0]
    .items;

describe('hasLoadedNotificationList', () => {
  it('is false when the tab has never loaded a notification list', () => {
    expect(hasLoadedNotificationList(new QueryClient(), filters)).toBe(false);
  });

  it('is false for a list that has no page yet', () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Comment', []);

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(false);
  });

  it('is false when the only loaded list is another category’s', () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Buzz');

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(false);
  });

  it('is true once the All list is loaded', () => {
    const queryClient = new QueryClient();
    loaded(queryClient, undefined);

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(true);
  });

  it('is true once the notification’s category list is loaded', () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Comment');

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(true);
  });
});

describe('insertSignalledNotification', () => {
  it('does not fetch in a tab with no loaded notification list', async () => {
    const queryClient = new QueryClient();
    const fetchImpl = okFetch();

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('fetches once and writes the enriched row into the loaded category list', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Comment');
    const fetchImpl = okFetch();

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/notification/getDetails');
    expect(firstItems(queryClient, 'Comment')[0]).toEqual({
      ...SIGNALLED,
      details: { commentId: 731, content: 'hi' },
    });
  });

  it('still writes the unenriched row when the detail request fails', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Comment');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 400 }));

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(firstItems(queryClient, 'Comment')[0]).toEqual(SIGNALLED);
  });

  it('does not fetch when only another category’s list is loaded, and leaves that list alone', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Buzz');
    const fetchImpl = okFetch();

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(firstItems(queryClient, 'Buzz')).toEqual([{ id: 4 }]);
  });

  it('fetches once and writes the row into the loaded All list', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, undefined);
    const fetchImpl = okFetch();

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(firstItems(queryClient, undefined)[0]).toEqual({
      ...SIGNALLED,
      details: { commentId: 731, content: 'hi' },
    });
  });

  it('writes into the All list when unread-only is on', async () => {
    const queryClient = new QueryClient();
    const unreadKey = getQueryKey(
      trpc.notification.getAllByUser,
      { limit: 30, category: undefined, unread: true } as never,
      'infinite'
    );
    queryClient.setQueryData(unreadKey, { pages: [page([4])], pageParams: [undefined] });

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, okFetch());

    const items = (queryClient.getQueryData(unreadKey) as { pages: { items: unknown[] }[] })
      .pages[0].items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: SIGNALLED.id });
  });

  it('writes into All and the category list but not into another category’s list', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, undefined);
    loaded(queryClient, 'Comment');
    loaded(queryClient, 'Buzz');

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, okFetch());

    expect(firstItems(queryClient, undefined)).toHaveLength(2);
    expect(firstItems(queryClient, 'Comment')).toHaveLength(2);
    expect(firstItems(queryClient, 'Buzz')).toEqual([{ id: 4 }]);
  });
});

/** A debounced notification (a collection gaining items) is re-surfaced under its existing id. */
const COLLECTION_UPDATE = {
  id: 88123,
  type: 'contest-collection-item-status-change',
  category: 'Update',
  details: {},
  createdAt: '2026-11-08T08:30:00.000Z',
  read: false,
} as unknown as NotificationGetAllItem;

const detailFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ details: { collectionId: 9 } })));

const listOf = (items: Array<{ id: number; read: boolean }>) => [{ items, nextCursor: undefined }];
const ids = (queryClient: QueryClient, category?: string) =>
  (firstItems(queryClient, category) as Array<{ id: number }>).map((item) => item.id);

describe('a re-signalled notification', () => {
  it('is written into All and Updates only, never Comments', async () => {
    const queryClient = new QueryClient();
    for (const category of [undefined, 'Update', 'Comment'])
      loaded(queryClient, category, listOf([{ id: 4, read: true }]));

    await insertSignalledNotification(queryClient, LIST_KEY, COLLECTION_UPDATE, detailFetch());

    expect(ids(queryClient, undefined)).toEqual([88123, 4]);
    expect(ids(queryClient, 'Update')).toEqual([88123, 4]);
    expect(ids(queryClient, 'Comment')).toEqual([4]);
  });

  it('leaves one row, moved to the top, when the list already holds that id', async () => {
    const queryClient = new QueryClient();
    const pages = listOf([
      { id: 4, read: true },
      { id: 88123, read: true },
    ]);
    loaded(queryClient, undefined, pages);
    loaded(queryClient, 'Update', pages);

    await insertSignalledNotification(queryClient, LIST_KEY, COLLECTION_UPDATE, detailFetch());
    await insertSignalledNotification(queryClient, LIST_KEY, COLLECTION_UPDATE, detailFetch());

    expect(ids(queryClient, undefined)).toEqual([88123, 4]);
    expect(ids(queryClient, 'Update')).toEqual([88123, 4]);
    expect(firstItems(queryClient, 'Update')[0]).toMatchObject({ read: false });
  });

  it('finds the existing row on a later page too', async () => {
    const queryClient = new QueryClient();
    const pages = [
      { items: [{ id: 4, read: true }], nextCursor: 'c' },
      { items: [{ id: 88123, read: true }], nextCursor: undefined },
    ];
    queryClient.setQueryData(panelKey('Update'), { pages, pageParams: [undefined, 'c'] });

    await insertSignalledNotification(queryClient, LIST_KEY, COLLECTION_UPDATE, detailFetch());

    const data = queryClient.getQueryData(panelKey('Update')) as {
      pages: { items: Array<{ id: number }> }[];
    };
    expect(data.pages.map((p) => p.items.map((item) => item.id))).toEqual([[88123, 4], []]);
  });

  it('matches a string id from the signal against a numeric id in the list', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Update', listOf([{ id: 88123, read: true }]));
    const signal = { ...COLLECTION_UPDATE, id: '88123' } as unknown as NotificationGetAllItem;

    await insertSignalledNotification(queryClient, LIST_KEY, signal, detailFetch());

    expect(firstItems(queryClient, 'Update')).toHaveLength(1);
  });
});

describe('badge counts on a signal', () => {
  const run = async (queryClient: QueryClient) => {
    let counts: Record<string, number> = { all: 3, update: 2, comment: 1 };
    await handleNotificationSignal(
      queryClient,
      LIST_KEY,
      COLLECTION_UPDATE,
      (updater) => (counts = updater(counts)),
      detailFetch()
    );
    return counts;
  };

  it('are unchanged when a loaded list already holds that id unread', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Update', listOf([{ id: 88123, read: false }]));

    expect(await run(queryClient)).toEqual({ all: 3, update: 2, comment: 1 });
  });

  it('are unchanged when only the All list holds that id unread', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, undefined, listOf([{ id: 88123, read: false }]));

    expect(await run(queryClient)).toEqual({ all: 3, update: 2, comment: 1 });
  });

  it('go up by one when the held row was read', async () => {
    const queryClient = new QueryClient();
    loaded(queryClient, 'Update', listOf([{ id: 88123, read: true }]));

    expect(await run(queryClient)).toEqual({ all: 4, update: 3, comment: 1 });
  });

  it('go up by one for a notification no loaded list holds', async () => {
    expect(await run(new QueryClient())).toEqual({ all: 4, update: 3, comment: 1 });
  });
});
