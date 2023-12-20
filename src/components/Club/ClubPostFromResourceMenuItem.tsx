import { Menu } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SupportedClubPostEntities } from '~/server/schema/club.schema';
import { dialogStore } from '../Dialog/dialogStore';
import { useQueryUserContributingClubs } from './club.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMemo } from 'react';
import { ClubAdminPermission } from '@prisma/client';
import { ClubPostFromResourceModal } from './ClubPost/ClubPostUpsertForm';
import { IconPencilPin } from '@tabler/icons-react';

export function ClubPostFromResourceMenuItem({ entityType, entityId }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { userClubs, hasClubs, isLoading: isLoadingUserClubs } = useQueryUserContributingClubs();
  const canCreateClubPostClubs = useMemo(() => {
    return (
      userClubs?.filter(
        (club) =>
          club.userId === currentUser?.id ||
          club.admin?.permissions.includes(ClubAdminPermission.ManagePosts)
      ) ?? []
    );
  }, [userClubs, currentUser]);

  const onClick = async () => {
    dialogStore.trigger({
      component: ClubPostFromResourceModal,
      props: {
        entityType,
        entityId,
      },
    });
  };

  if (!features.clubs || canCreateClubPostClubs?.length === 0 || isLoadingUserClubs) {
    return null;
  }

  return (
    <Menu.Item
      icon={<IconPencilPin size={14} stroke={1.5} />}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      key="create-club-post-from-resource"
    >
      Create club post
    </Menu.Item>
  );
}

type Props = {
  entityType: SupportedClubPostEntities;
  entityId: number;
};
