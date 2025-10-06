import type { InfiniteData } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useCallback, useMemo } from 'react';
import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
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
    { getNextPageParam: (lastPage) => lastPage.nextCursor, keepPreviousData: true, ...options }
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

export const useQueryNotificationsCount = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.user.checkNotifications.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });

  const { data: allAnnouncements, isLoading: announcementsLoading } = useGetAnnouncements();
  const announcements = allAnnouncements.filter((x) => !x.dismissed);

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
      }
    : { ...data, all: data.all + announcements.length, announcements: announcements.length };
};

export const useMarkReadNotification = () => {
  const queryUtils = trpc.useUtils();
  const queryClient = useQueryClient();

  const mutation = trpc.notification.markRead.useMutation({
    async onMutate({ category, all, id }) {
      // Lower notification count
      const categoryStr = category?.toLowerCase();

      await queryUtils.user.checkNotifications.cancel();
      queryUtils.user.checkNotifications.setData(undefined, (old) => {
        const newCounts: Record<string, number> = { ...old, all: old?.all ?? 0 };

        if (id) {
          // if we have an id, set that category-- and all-- and that's it
          newCounts['all']--;
          if (!!categoryStr && categoryStr in newCounts) {
            newCounts[categoryStr]--;
          }
        } else {
          if (!!categoryStr) {
            // otherwise, if we have a category, set that to 0 and -X from all
            if (categoryStr in newCounts) {
              newCounts['all'] -= newCounts[categoryStr] ?? 0;
              newCounts[categoryStr] = 0;
            }
          } else {
            // if we don't, set everything to 0
            for (const key of Object.keys(newCounts)) {
              newCounts[key] = 0;
            }
          }
        }

        for (const key of Object.keys(newCounts)) {
          if (newCounts[key] < 0) newCounts[key] = 0;
        }

        return newCounts;
      });

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
        const newCounts: Record<string, number> = { ...old, all: old?.all ?? 0 };
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
