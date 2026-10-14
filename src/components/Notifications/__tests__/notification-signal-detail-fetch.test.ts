import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  hasLoadedNotificationList,
  notificationListFilters,
} from '~/components/Notifications/notifications.utils';

/**
 * A new-notification signal used to trigger a detail fetch in every open tab, whether or not that tab
 * had ever opened its notifications. The response is only ever written into a notification list that
 * is already loaded, so in a tab without one it was discarded: a request per signal, per tab, for
 * nothing.
 *
 * `hasLoadedNotificationList` is the condition the signal handler now fetches on. These tests use a
 * real `QueryClient`, because the question is what the cache's own key matching says.
 */
const LIST_KEY = ['notification', 'getAllByUser'];
const listKey = (input: Record<string, unknown>) => [LIST_KEY, { input, type: 'infinite' }];
const page = (ids: number[]) => ({ items: ids.map((id) => ({ id })), nextCursor: undefined });

const filters = notificationListFilters(LIST_KEY, 'Comment');

describe('notificationListFilters', () => {
  it('targets the All list and the notification’s own category list', () => {
    expect(filters).toEqual([
      { queryKey: [LIST_KEY, { input: { category: null } }], exact: false },
      { queryKey: [LIST_KEY, { input: { category: 'Comment' } }], exact: false },
    ]);
  });
});

describe('hasLoadedNotificationList', () => {
  it('is false when the tab has never loaded a notification list', () => {
    expect(hasLoadedNotificationList(new QueryClient(), filters)).toBe(false);
  });

  it('is false when only unrelated queries are cached', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([['user', 'checkNotifications']], { all: 3 });

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(false);
  });

  it('is false for a list that has no page yet', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(listKey({ limit: 30, category: 'Comment' }), {
      pages: [],
      pageParams: [],
    });

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(false);
  });

  it('is false when the only loaded list is another category’s', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(listKey({ limit: 30, category: 'Buzz' }), {
      pages: [page([4])],
      pageParams: [undefined],
    });

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(false);
  });

  it('is true once the notification’s category list is loaded', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(listKey({ limit: 30, category: 'Comment' }), {
      pages: [page([4])],
      pageParams: [undefined],
    });

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(true);
  });

  it('is true once a list keyed on `category: null` is loaded', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(listKey({ limit: 30, category: null }), {
      pages: [page([4])],
      pageParams: [undefined],
    });

    expect(hasLoadedNotificationList(queryClient, filters)).toBe(true);
  });

  it('agrees with the write: true exactly when the same filters reach a list with a page', () => {
    // The fetch is skipped on this answer, so it must never be false while a write would still land.
    const states: Array<[string, Record<string, unknown> | null, unknown[]]> = [
      ['nothing cached', null, []],
      ['own category, loaded', { category: 'Comment' }, [page([1])]],
      ['own category, no page', { category: 'Comment' }, []],
      ['other category, loaded', { category: 'Buzz' }, [page([1])]],
      ['category null, loaded', { category: null }, [page([1])]],
    ];

    for (const [name, input, pages] of states) {
      const queryClient = new QueryClient();
      if (input) queryClient.setQueryData(listKey(input), { pages, pageParams: [] });

      let written = 0;
      for (const filter of filters) {
        queryClient.setQueriesData<{ pages: unknown[] }>(filter, (old) => {
          if (old?.pages?.length) written++;
          return old;
        });
      }

      expect(hasLoadedNotificationList(queryClient, filters), name).toBe(written > 0);
    }
  });
});
