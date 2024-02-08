import { useEffect, useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { useInView } from 'react-intersection-observer';
import { useDebouncedValue } from '@mantine/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const useQueryNotifications = (
  filters?: Partial<GetUserNotificationsSchema>,
  options?: { enabled?: boolean; keepPreviousData?: boolean }
) => {
  const [ref, inView] = useInView();

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.notification.getAllByUser.useInfiniteQuery(
      { limit: 100, ...filters },
      { getNextPageParam: (lastPage) => lastPage.nextCursor, keepPreviousData: true, ...options }
    );
  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages]
  );

  const [debouncedInView] = useDebouncedValue(inView, 300);

  useEffect(() => {
    console.log({ debouncedInView, hasNextPage, isFetchingNextPage });
    if (debouncedInView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, debouncedInView, isFetchingNextPage]);

  return { data, notifications, isLoading, ref, hasNextPage };
};

export const useQueryNotificationsCount = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.user.checkNotifications.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });

  return isLoading || !data
    ? { all: 0, comment: 0, milestone: 0, update: 0, bounty: 0, other: 0 }
    : { ...data };
};
