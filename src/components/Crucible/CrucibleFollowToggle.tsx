import { Tooltip } from '@mantine/core';
import { IconBell, IconBellFilled } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import {
  useFollowedCrucibleIds,
  useToggleCrucibleFollow,
} from '~/components/Crucible/crucible.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CRUCIBLE_FOLLOWABLE_STATUSES } from '~/shared/constants/crucible.constants';
import type { CrucibleStatus } from '~/shared/utils/prisma/enums';

type Props = {
  crucible: { id: number; status: CrucibleStatus };
};

export function CrucibleFollowToggle({ crucible }: Props) {
  const currentUser = useCurrentUser();
  const followable = CRUCIBLE_FOLLOWABLE_STATUSES.includes(crucible.status);
  const { followedIds } = useFollowedCrucibleIds({ enabled: followable });
  const { toggleFollow, toggling } = useToggleCrucibleFollow();

  if (!currentUser || !followable) return null;

  const following = followedIds.has(crucible.id);
  const label = following ? 'Unfollow this crucible' : 'Follow: notify me before this ends';

  return (
    <Tooltip label={label} withinPortal>
      <LegacyActionIcon
        variant="light"
        size="lg"
        color={following ? 'blue' : 'gray'}
        aria-label={label}
        aria-pressed={following}
        disabled={toggling}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          void toggleFollow(crucible.id, !following);
        }}
      >
        {following ? <IconBellFilled size={20} /> : <IconBell size={20} />}
      </LegacyActionIcon>
    </Tooltip>
  );
}
