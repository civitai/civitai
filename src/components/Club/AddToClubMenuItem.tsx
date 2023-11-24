import { Menu } from '@mantine/core';
import { IconClubs, IconHeart } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { openManageClubPostModal } from '~/components/Modals/ManageClubPostModal';

export function AddToClubMenuItem({ entityType, entityId }: Props) {
  const features = useFeatureFlags();
  const { data: userContributingClubs = [], isLoading } = trpc.club.userContributingClubs.useQuery(
    undefined,
    {
      enabled: features.clubs,
    }
  );

  const onClick = async () => {
    openManageClubPostModal({ entityType, entityId });
  };

  if (!features.clubs || isLoading || userContributingClubs?.length === 0) {
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
      key="add-to-showcase"
    >
      Add to club
    </Menu.Item>
  );
}

type Props = { entityType: SupportedClubEntities; entityId: number };
