import { Menu } from '@mantine/core';
import { IconClubs } from '@tabler/icons-react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { dialogStore } from '../Dialog/dialogStore';
import { useEntityAccessRequirement, useQueryUserContributingClubs } from './club.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMemo } from 'react';
import { ClubAdminPermission } from '@prisma/client';
import { ClubPostFromResourceModal } from './ClubPost/ClubPostUpsertForm';

export function ClubPostFromResourceMenuItem({ entityType, entityId }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { userClubs, hasClubs, isLoading: isLoadingUserClubs } = useQueryUserContributingClubs();
  const { hasAccess, requiresClub, clubRequirement, isLoadingAccess } = useEntityAccessRequirement({
    entityType,
    entityId,
  });
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

  if (
    !features.clubs ||
    canCreateClubPostClubs?.length === 0 ||
    isLoadingUserClubs ||
    isLoadingAccess ||
    !hasAccess
  ) {
    return null;
  }

  // check that the user can create a post with THIS club specifically:
  const canCreatePost =
    !requiresClub ||
    clubRequirement?.clubs?.find((c) => canCreateClubPostClubs.some((cc) => cc.id === c.clubId));

  if (!canCreatePost) {
    return null;
  }

  return (
    <Menu.Item
      icon={<IconClubs size={14} stroke={1.5} />}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      key="create-club-post-from-resource"
    >
      Create club post from this resource
    </Menu.Item>
  );
}

type Props = {
  entityType: SupportedClubEntities;
  entityId: number;
};
