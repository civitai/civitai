import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function useCreatorAnnouncementsFeature() {
  const features = useFeatureFlags();
  return features.creatorAnnouncements;
}

export function useQueryCreatorAnnouncements(userId?: number, limit = 10) {
  const enabled = useCreatorAnnouncementsFeature();
  const { data, isLoading } = trpc.announcement.getCreatorAnnouncements.useQuery(
    { userId: userId as number, limit },
    { enabled: enabled && !!userId }
  );

  return { announcements: data ?? [], isLoading: enabled && !!userId ? isLoading : false };
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
      await queryUtils.announcement.getCreatorAnnouncements.invalidate();
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
