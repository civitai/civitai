import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
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

describe('notificationListFilters', () => {
  it('targets the All list and the notification’s own category list', () => {
    expect(filters).toEqual([
      { queryKey: [['notification', 'getAllByUser'], { input: { category: null } }], exact: false },
      {
        queryKey: [['notification', 'getAllByUser'], { input: { category: 'Comment' } }],
        exact: false,
      },
    ]);
  });
});

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

  it('the panel’s All list (no category in its key) receives no write, so it costs no fetch', async () => {
    // Pre-existing and unchanged: the All filter asks for `category: null`, the panel's All query has
    // no category at all, and the cache's partial key match does not treat the two as equal. This pins
    // that the fetch follows the write — not that the All list is right to be skipped.
    const queryClient = new QueryClient();
    loaded(queryClient, undefined);
    const fetchImpl = okFetch();

    await insertSignalledNotification(queryClient, LIST_KEY, SIGNALLED, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(firstItems(queryClient, undefined)).toEqual([{ id: 4 }]);
  });
});
