import { withPlaceholderData } from '~/hooks/trpcHelpers';
import type { InfiniteData } from '@tanstack/react-query';
import { useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useCallback, useMemo } from 'react';
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
      placeholderData: keepPreviousData,
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
        // Placements waiting on this user, for the user menu badge. Carried on
        // this query rather than its own, and kept out of `all` — `all` is the
        // bell, and a pending placement is not an unread notification.
        pendingPlacements: 0,
        pendingStickerPlacements: 0,
        pendingRemixSubmissions: 0,
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
 * 🔴 This set is load-bearing, and the reason is not obvious from the code it
 * guards. The two branches that key off a category name are safe only because
 * they test `category.toLowerCase() in counts` and this key is camelCase —
 * `'pendingplacements'` matches nothing. That is a casing accident, not a
 * design. Rename this field to lowercase, or add a NotificationCategory that
 * lowercases into it, and the category branch would start subtracting a
 * placement count out of the bell's total.
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

export const useNotificationSignal = () => {
  const queryClient = useQueryClient();
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    async (updated: NotificationGetAllItem) => {
      const queryKey = getQueryKey(trpc.notification.getAllByUser)[0];

      // nb: this shouldn't run if "old" doesn't exist, but can't test that yet, and produce doesn't allow async
      let newUpdated = updated;
      try {
        const newUpdatedResp = await fetch('/api/notification/getDetails', {
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

      // update All + "Category" cache
      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey: [queryKey, { input: { category: null } }], exact: false },
        produce((old) => {
          if (!old || !old.pages || !old.pages.length) return;
          const firstPage = old.pages[0];
          firstPage.items.unshift(newUpdated);
        })
      );
      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey: [queryKey, { input: { category: updated.category } }], exact: false },
        produce((old) => {
          if (!old || !old.pages || !old.pages.length) return;
          const firstPage = old.pages[0];
          firstPage.items.unshift(newUpdated);
        })
      );

      queryUtils.user.checkNotifications.setData(undefined, (old) => {
        // Writes two named keys only, so unlike the mark-read updater it cannot
        // touch a non-category count. The cast is the index access, not a claim
        // that every key here is a category.
        const newCounts = { ...old, all: old?.all ?? 0 } as NonNullable<typeof old> &
          Record<string, number>;
        newCounts[updated.category.toLowerCase()] =
          (newCounts[updated.category.toLowerCase()] ?? 0) + 1;
        newCounts['all']++;

        return newCounts;
      });
    },
    [queryClient, queryUtils]
  );

  useSignalConnection(SignalMessages.NotificationNew, onUpdate);
};
