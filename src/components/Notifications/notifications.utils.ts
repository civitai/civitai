import { withPlaceholderData } from '~/hooks/trpcHelpers';
import type { InfiniteData, Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useCallback, useEffect, useMemo } from 'react';
import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import {
  selectUndismissedAnnouncements,
  useDismissedCreatorAnnouncements,
} from '~/components/Announcements/creator-announcement-dismissals';
import { useQueryFollowedAnnouncements } from '~/components/Announcements/creator-announcements.utils';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotificationCategory, SignalMessages } from '~/server/common/enums';
import type { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import type { NotificationGetAll, NotificationGetAllItem } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const categoryNameMap: Partial<Record<NotificationCategory, string>> = {
  [NotificationCategory.Comment]: 'Comments',
  [NotificationCategory.Milestone]: 'Milestones',
  [NotificationCategory.Update]: 'Updates',
  [NotificationCategory.Bounty]: 'Bounties',
  [NotificationCategory.Referral]: 'Referrals',
  [NotificationCategory.Other]: 'Others',
};
export const getCategoryDisplayName = (category: string) =>
  categoryNameMap[category as NotificationCategory] ?? getDisplayName(category);

export const useQueryNotifications = (
  filters?: Partial<GetUserNotificationsSchema>,
  options?: { enabled?: boolean; keepPreviousData?: boolean }
) => {
  const { data, ...rest } = trpc.notification.getAllByUser.useInfiniteQuery(
    { limit: 100, ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      ...withPlaceholderData(options),
    }
  );
  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages]
  );

  return { data, notifications, ...rest };
};

export function useGetAnnouncementsAsNotifications({
  hideRead,
}: {
  hideRead?: boolean;
}): NotificationGetAllItem[] {
  const { data } = useGetAnnouncements();
  return useMemo(
    () =>
      data
        ?.map(
          (announcement) =>
            ({
              id: announcement.id,
              type: 'announcement',
              category: 'announcement' as any,
              createdAt: announcement.startsAt,
              // Announcements are not paged, so they carry no list cursor position.
              cursorAt: '',
              read: announcement.dismissed,
              details: {
                url: announcement.metadata?.actions?.[0]?.link,
                target: '_blank',
                message: announcement.title,
                actor: undefined,
                content: undefined,
                type: 'announcement',
              },
            } as NotificationGetAllItem)
        )
        .filter((x) => (hideRead ? !x.read : true)),
    [data, hideRead]
  );
}

/**
 * The Announcements tab holds two independently-fetched, independently-dismissed sets —
 * Civitai's own and the ones from creators you follow — and its badge is the count of what
 * is undismissed across both.
 *
 * It takes the followed announcements and the dismissal set rather than a number, so the
 * call site has nothing left to get wrong: the bug this fixes was the creator half never
 * reaching the counter, and a function that accepts a count cannot tell a real one from a
 * zero. Everything that decides the number is inside here, where a test can reach it.
 */
export function withAnnouncementCounts<T extends { all: number }>(
  counts: T,
  {
    platform,
    followed,
    dismissedIds,
  }: { platform: number; followed: { id: number }[]; dismissedIds: number[] }
): T & { announcements: number } {
  const announcements = platform + selectUndismissedAnnouncements(followed, dismissedIds).length;
  return { ...counts, all: counts.all + announcements, announcements };
}

/**
 * Which halves the "mark as read" button clears, per tab.
 *
 * The announcements half is cleared from the All tab too, not just the Announcements tab:
 * the bell renders `all`, which now includes announcements, so a button labelled "Mark all
 * as read" that skipped them would drop the bell to a number the tab it was clicked on has
 * no way to clear.
 */
export function resolveMarkAsRead(selectedTab: string | null) {
  const isAnnouncementsTab = selectedTab === 'announcements';
  return {
    clearsAnnouncements: isAnnouncementsTab || !selectedTab,
    marksNotificationsRead: !isAnnouncementsTab,
  };
}

/**
 * Clearing the announcements half of the tab: both sets, or the badge goes up on a creator
 * post and then refuses to come down — a worse bug than the uncounted one this fixes.
 *
 * Takes its two dismissers so the pair can be asserted. Dropping either call is otherwise
 * invisible: they write to browser storage and return nothing.
 */
export function clearAnnouncements(
  { platformIds, creatorIds }: { platformIds: number[]; creatorIds: number[] },
  dismiss: { platform: (ids: number[]) => void; creator: (ids: number[]) => void }
) {
  dismiss.platform(platformIds);
  dismiss.creator(creatorIds);
}

// A floor is a lower bound from a recount that stopped at its row limit, hence the "+".
export function formatUnreadCount(count: number, isFloor: boolean): string {
  if (count >= 1000) return '1k+';
  return isFloor ? `${count}+` : `${count}`;
}

export function formatBellCount(counts: { all: number; unreadCountsAreFloors?: number }): string {
  if (counts.all > 99) return '99+';
  return counts.unreadCountsAreFloors ? `${counts.all}+` : `${counts.all}`;
}

// Announcements are counted client-side and exactly; only the server's notification counts can be floors.
export function formatTabCount(tab: string, counts: Record<string, number>): string {
  return formatUnreadCount(
    counts[tab.toLowerCase()] ?? 0,
    tab !== 'announcements' && !!counts.unreadCountsAreFloors
  );
}

export const useQueryNotificationsCount = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.user.checkNotifications.useQuery(undefined, {
    enabled: !!currentUser,
    gcTime: Infinity,
    staleTime: Infinity,
  });

  const { data: allAnnouncements, isLoading: announcementsLoading } = useGetAnnouncements();
  const announcements = allAnnouncements.filter((x) => !x.dismissed);

  // Followed-creator announcements are the SAME tab and the same dismiss affordance as the
  // rows above, so they belong in the same number — but they are a different query with a
  // different dismissal store, so the count has to be assembled here rather than server-side.
  // Same input as the panel's own call, so the two share one cache entry instead of fetching
  // twice.
  const { announcements: followedAnnouncements } = useQueryFollowedAnnouncements(!!currentUser);
  const dismissedCreatorIds = useDismissedCreatorAnnouncements();

  // Deliberately NOT gated on the followed query's loading state: this hook drives the header
  // bell on every page, and adding a third gate would blank the whole badge until a query the
  // rest of it does not need has landed.
  return isLoading || announcementsLoading || !data || !announcements
    ? {
        all: 0,
        comment: 0,
        milestone: 0,
        update: 0,
        bounty: 0,
        other: 0,
        system: 0,
        buzz: 0,
        announcements: 0,
        unreadCountsAreFloors: 0,
        // Queues waiting on this user, for the user-menu badges. Carried on
        // this query rather than its own, and kept out of `all` — `all` is the
        // bell, and a pending placement is not an unread notification.
        pendingPlacements: 0,
        pendingStickerPlacements: 0,
        pendingRemixSubmissions: 0,
        pendingCollectionReviews: 0,
        unopenedBoxes: 0,
        unclaimedPrizes: 0,
      }
    : withAnnouncementCounts(data, {
        platform: announcements.length,
        followed: followedAnnouncements,
        dismissedIds: dismissedCreatorIds,
      });
};

/**
 * Keys on the `checkNotifications` payload that are NOT notification category
 * counts, and must survive "mark all as read".
 *
 * `unreadCountsAreFloors` is the one non-category key deliberately NOT listed:
 * mark-all-read zeroes every count, a zero is exact, so the flag must be wiped
 * with them.
 *
 * 🔴 This set is load-bearing, and the reason is not obvious from the code it
 * guards. The two branches that key off a category name are safe only because
 * they test `category.toLowerCase() in counts` and every key here (and
 * `unreadCountsAreFloors`) is camelCase — `'pendingplacements'` matches
 * nothing. That is a casing accident, not a design. Rename one of these keys
 * to lowercase, or add a NotificationCategory that lowercases into one, and
 * the category branch would start subtracting it out of the bell's total.
 *
 * The blanket branch has no such accident protecting it: it iterates every key,
 * so a non-category count added to this payload is zeroed by one click on "mark
 * all as read" and — since the query is `staleTime: Infinity` with no
 * invalidation anywhere — stays zero until a full page load. That is exactly
 * what shipped when `pendingPlacements` was added: for an owner without the
 * `stickerPlacement` flag, whose menu entry is gated on a nonzero count, the
 * wipe did not just clear the badge, it removed the entry.
 */
export const NON_CATEGORY_COUNT_KEYS: ReadonlySet<string> = new Set([
  'pendingPlacements',
  'pendingStickerPlacements',
  'pendingRemixSubmissions',
  'pendingCollectionReviews',
  'unopenedBoxes',
  'unclaimedPrizes',
]);

type NotificationCounts = Record<string, number>;

/**
 * The optimistic count update for `notification.markRead`, as a pure function so
 * it can be tested without a mutation, a provider, or a click.
 *
 * Extracted rather than left inline because the bug above was invisible in a
 * closure inside a `useMutation` option: nothing could reach it to assert on it.
 */
export function applyMarkReadToCounts<T extends NotificationCounts>(
  old: T | undefined,
  { id, category }: { id?: unknown; category?: string | null }
): T {
  const categoryStr = category?.toLowerCase();
  // Widened to the index signature for the body, narrowed back on return: the
  // branches below index by a category name computed at runtime, which TS will
  // not allow on a generic. The cast is the dynamic access, not a claim that
  // every key is a category — see NON_CATEGORY_COUNT_KEYS.
  const newCounts: NotificationCounts = { ...old, all: old?.all ?? 0 };

  if (id) {
    // if we have an id, set that category-- and all-- and that's it
    newCounts['all']--;
    if (!!categoryStr && categoryStr in newCounts) {
      newCounts[categoryStr]--;
    }
  } else if (!!categoryStr) {
    // otherwise, if we have a category, set that to 0 and -X from all
    if (categoryStr in newCounts) {
      newCounts['all'] -= newCounts[categoryStr] ?? 0;
      newCounts[categoryStr] = 0;
    }
  } else {
    // if we don't, set every CATEGORY to 0 — see NON_CATEGORY_COUNT_KEYS.
    for (const key of Object.keys(newCounts)) {
      if (NON_CATEGORY_COUNT_KEYS.has(key)) continue;
      newCounts[key] = 0;
    }
  }

  for (const key of Object.keys(newCounts)) {
    // Skipped by name here too, not because a count can go negative — it cannot
    // — but so that every loop over this object states the same rule. A loop
    // that happens to be harmless is where the next one gets copied from.
    if (NON_CATEGORY_COUNT_KEYS.has(key)) continue;
    if (newCounts[key] < 0) newCounts[key] = 0;
  }

  return newCounts as T;
}

export const useMarkReadNotification = () => {
  const queryUtils = trpc.useUtils();
  const queryClient = useQueryClient();

  const mutation = trpc.notification.markRead.useMutation({
    async onMutate({ category, all, id }) {
      // Also used by the notification-feed updater below.
      const categoryStr = category?.toLowerCase();

      await queryUtils.user.checkNotifications.cancel();
      queryUtils.user.checkNotifications.setData(undefined, (old) =>
        applyMarkReadToCounts(old, { id, category })
      );

      // Mark as read in notification feed
      const queryKey = getQueryKey(trpc.notification.getAllByUser);
      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey, exact: false },
        produce((old) => {
          if (!old) return;

          for (const page of old?.pages ?? []) {
            if (all) {
              for (const item of page.items) {
                const categoryMatch = !categoryStr || item.category.toLowerCase() === categoryStr;
                if (categoryMatch) item.read = true;
              }
            } else if (id) {
              const item = page.items?.find((x) => x.id == id);
              if (item) item.read = true;
            }
          }
        })
      );
    },
  });

  return mutation;
};

/** Subtracts what the server reports it cleared, per category, from the badge counts. */
export function applyClearedToCounts<T extends NotificationCounts>(
  old: T,
  cleared: Array<{ category: string; count: number }>
): T {
  const next: NotificationCounts = { ...old };
  for (const { category, count } of cleared) {
    const key = category.toLowerCase();
    if (NON_CATEGORY_COUNT_KEYS.has(key) || !(key in next)) continue;
    next[key] = Math.max(0, next[key] - count);
    next.all = Math.max(0, (next.all ?? 0) - count);
  }
  return next as T;
}

// Per page load, so stepping back and forth through a carousel asks once per image.
const imagesMarkedOnView = new Set<number>();

export function shouldMarkImageMilestonesRead(
  imageId: number | undefined,
  unreadMilestones: number,
  alreadyAsked: ReadonlySet<number>
): imageId is number {
  return imageId != null && unreadMilestones > 0 && !alreadyAsked.has(imageId);
}

/** Clears the viewer's milestone notifications for an image they own when they view it. */
export function useMarkImageMilestonesReadOnView(ownImageId: number | undefined) {
  const currentUser = useCurrentUser();
  // The bell's own query and options, read directly: `useQueryNotificationsCount` also mounts the
  // announcement queries, which the image viewer has no use for.
  const { data: counts } = trpc.user.checkNotifications.useQuery(undefined, {
    enabled: !!currentUser,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const milestone = counts?.milestone ?? 0;
  const queryUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { mutate } = trpc.notification.markImageMilestonesRead.useMutation({
    onSuccess(cleared, { imageId }) {
      if (!cleared.length) return;
      queryUtils.user.checkNotifications.setData(undefined, (old) =>
        old ? applyClearedToCounts(old, cleared) : old
      );
      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey: getQueryKey(trpc.notification.getAllByUser), exact: false },
        produce((old) => {
          for (const page of old?.pages ?? [])
            for (const item of page.items)
              if (item.type === 'image-reaction-milestone' && item.details?.imageId === imageId)
                item.read = true;
        })
      );
    },
  });

  useEffect(() => {
    if (!shouldMarkImageMilestonesRead(ownImageId, milestone, imagesMarkedOnView)) return;
    imagesMarkedOnView.add(ownImageId);
    mutate({ imageId: ownImageId });
  }, [ownImageId, milestone, mutate]);
}

/**
 * The cached notification lists a newly-signalled notification is written into: All + its category.
 *
 * One list for both the write and the question "is there anything to write into", so the two cannot
 * drift — see `hasLoadedNotificationList`.
 */
export function notificationListFilters(listKey: QueryKey[number], category: string) {
  return [
    // Predicate, not `{ input: { category: null } }`: the All tab's key holds `category: undefined`,
    // and partial key matching does not equate that with null.
    {
      queryKey: [listKey],
      predicate: ({ queryKey }: Query) =>
        !(queryKey[1] as { input?: { category?: unknown } } | undefined)?.input?.category,
    },
    { queryKey: [listKey, { input: { category } }], exact: false },
  ];
}

/**
 * Whether any of those lists holds a page — the same condition the write below applies per list.
 *
 * The detail fetch on a new-notification signal exists only to enrich the row that gets written into a
 * loaded list. A tab that has never opened its notifications has no such list, so the response would
 * be thrown away: one authenticated request per signal, per open tab, for nothing. This is what lets
 * the signal handler skip it. A list loaded later is fetched from the server and already carries the
 * notification, enriched.
 */
export function hasLoadedNotificationList(
  queryClient: Pick<QueryClient, 'getQueriesData'>,
  filters: ReturnType<typeof notificationListFilters>
): boolean {
  return filters.some((filter) =>
    queryClient
      .getQueriesData<InfiniteData<NotificationGetAll>>(filter)
      .some(([, old]) => !!old?.pages?.length)
  );
}

/**
 * Puts a newly-signalled notification into every loaded list it belongs in, enriched by the detail
 * endpoint when — and only when — there is such a list to put it in.
 *
 * Out of the hook so the gate can be exercised where it is applied, not just as a helper: `fetchImpl`
 * is the seam.
 */
export async function insertSignalledNotification(
  queryClient: Pick<QueryClient, 'getQueriesData' | 'setQueriesData'>,
  listKey: QueryKey[number],
  updated: NotificationGetAllItem,
  fetchImpl: typeof fetch = fetch
) {
  const listFilters = notificationListFilters(listKey, updated.category);

  let newUpdated = updated;
  if (hasLoadedNotificationList(queryClient, listFilters)) {
    try {
      const newUpdatedResp = await fetchImpl('/api/notification/getDetails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updated),
      });
      if (newUpdatedResp.ok) {
        const newUpdatedJson: NotificationGetAllItem = await newUpdatedResp.json();
        newUpdated = { ...newUpdated, ...newUpdatedJson };
      }
    } catch {}
  }

  let wasUnread = false;
  for (const filter of listFilters) {
    queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
      filter,
      produce((old) => {
        if (!old || !old.pages || !old.pages.length) return;
        // A debounced notification is re-surfaced under the same id, so the signal can name a row
        // the list already holds: move it to the top rather than adding a second one.
        for (const page of old.pages) {
          const index = page.items.findIndex((item) => item.id == newUpdated.id);
          if (index === -1) continue;
          if (!page.items[index].read) wasUnread = true;
          page.items.splice(index, 1);
        }
        old.pages[0].items.unshift(newUpdated);
      })
    );
  }

  return { wasUnread };
}

/** The badge bump for a signal: the notification's category and All, each by one. */
export function applySignalToCounts<T extends NotificationCounts>(
  old: T | undefined,
  category: string
): T {
  const next = { ...old, all: old?.all ?? 0 } as NotificationCounts;
  const key = category.toLowerCase();
  next[key] = (next[key] ?? 0) + 1;
  next.all++;
  return next as T;
}

/**
 * Applies a notification:new signal to the cache: the row into its lists, and one onto the badge
 * unless a loaded list already held it unread, since that unread row is already counted.
 */
export async function handleNotificationSignal(
  queryClient: Pick<QueryClient, 'getQueriesData' | 'setQueriesData'>,
  listKey: QueryKey[number],
  updated: NotificationGetAllItem,
  setCounts: (updater: (old: NotificationCounts | undefined) => NotificationCounts) => void,
  fetchImpl: typeof fetch = fetch
) {
  const { wasUnread } = await insertSignalledNotification(queryClient, listKey, updated, fetchImpl);
  if (!wasUnread) setCounts((old) => applySignalToCounts(old, updated.category));
}

export const useNotificationSignal = () => {
  const queryClient = useQueryClient();
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    async (updated: NotificationGetAllItem) => {
      await handleNotificationSignal(
        queryClient,
        getQueryKey(trpc.notification.getAllByUser)[0],
        updated,
        (updater) =>
          queryUtils.user.checkNotifications.setData(undefined, (old) => updater(old) as typeof old)
      );
    },
    [queryClient, queryUtils]
  );

  useSignalConnection(SignalMessages.NotificationNew, onUpdate);
};
