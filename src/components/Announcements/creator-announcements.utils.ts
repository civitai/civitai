import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useCreatorAnnouncementsFeature() {
  const features = useFeatureFlags();
  // Coerced HERE rather than at the four call sites: the sparse payload reads `undefined` when
  // the flag is absent, and `enabled: undefined` is ENABLED in React Query.
  return !!features.creatorAnnouncements;
}

export function useQueryCreatorAnnouncements(userId?: number, limit = 10) {
  const enabled = useCreatorAnnouncementsFeature();
  const { data, isLoading, isError } = trpc.announcement.getCreatorAnnouncements.useQuery(
    { userId: userId as number, limit },
    { enabled: enabled && !!userId }
  );

  const active = enabled && !!userId;
  return {
    announcements: data ?? [],
    isLoading: active ? isLoading : false,
    isError: active ? isError : false,
  };
}

export function useQueryFollowedAnnouncements(enabled = true, limit = 20) {
  const featureEnabled = useCreatorAnnouncementsFeature();
  const active = enabled && featureEnabled;
  const { data, isLoading } = trpc.announcement.getFollowedAnnouncements.useQuery(
    { limit },
    { enabled: active }
  );

  return { announcements: data?.items ?? [], isLoading: active ? isLoading : false };
}

export function useMutedCreators() {
  const enabled = useCreatorAnnouncementsFeature();
  const { data } = trpc.announcement.getMutedCreators.useQuery(undefined, { enabled });
  return data ?? [];
}

export function useIsCreatorMuted(creatorId?: number) {
  const enabled = useCreatorAnnouncementsFeature();
  const { data } = trpc.announcement.isCreatorMuted.useQuery(
    { creatorId: creatorId as number },
    { enabled: enabled && !!creatorId }
  );
  return data ?? false;
}

export function useToggleAnnouncementMute(creatorId: number) {
  const queryUtils = trpc.useUtils();
  const mutation = trpc.announcement.toggleAnnouncementMute.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        message: result.muted
          ? 'Announcements from this creator are muted'
          : 'Announcements from this creator are unmuted',
      });
      await Promise.all([
        queryUtils.announcement.getMutedCreators.invalidate(),
        queryUtils.announcement.isCreatorMuted.invalidate({ creatorId }),
        queryUtils.announcement.getFollowedAnnouncements.invalidate(),
      ]);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to update announcement mute',
        error: new Error(error.message),
      });
    },
  });

  return {
    toggle: (muted: boolean) => mutation.mutate({ creatorId, muted }),
    isLoading: mutation.isPending,
  };
}

export function useDeleteCreatorAnnouncement() {
  const queryUtils = trpc.useUtils();
  const mutation = trpc.announcement.deleteCreatorAnnouncement.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Announcement deleted' });
      // Both feeds, as the mute mutation above already does. The panel reads the followed
      // feed, and trpc sets `staleTime: Infinity` with `refetchOnWindowFocus: false` — so
      // without this a delete from the panel reports success and leaves the card on screen
      // for the rest of the session, where a second click reports failure.
      await Promise.all([
        queryUtils.announcement.getCreatorAnnouncements.invalidate(),
        queryUtils.announcement.getFollowedAnnouncements.invalidate(),
      ]);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to delete announcement',
        error: new Error(error.message),
      });
    },
  });

  return {
    deleteAnnouncement: (id: number) => mutation.mutate({ id }),
    isLoading: mutation.isPending,
  };
}
