import { Tooltip } from '@mantine/core';
import { IconBell, IconBellFilled } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import {
  useToggleChallengeNotify,
  useTrackedChallengeIds,
} from '~/components/Challenge/challenge.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

type Props = {
  challenge: { id: number; status: ChallengeStatus };
};

// Tracking only buys you something while the challenge still has an event ahead of it.
const TRACKABLE: ChallengeStatus[] = [ChallengeStatus.Scheduled, ChallengeStatus.Active];

export function ChallengeNotifyToggle({ challenge }: Props) {
  const currentUser = useCurrentUser();
  const { trackedIds } = useTrackedChallengeIds();
  const { toggleNotify, toggling } = useToggleChallengeNotify();

  if (!currentUser || !TRACKABLE.includes(challenge.status)) return null;

  const tracking = trackedIds.has(challenge.id);
  const isUpcoming = challenge.status === ChallengeStatus.Scheduled;

  const label = tracking
    ? 'Stop notifying me'
    : isUpcoming
    ? 'Notify me when this starts'
    : 'Notify me before this ends';

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void toggleNotify(challenge.id, !tracking);
  };

  // Sized to sit in the detail-page header alongside the share and overflow actions.
  return (
    <Tooltip label={label} withinPortal>
      <LegacyActionIcon
        variant="light"
        size="lg"
        color={tracking ? 'blue' : 'gray'}
        aria-label={label}
        disabled={toggling}
        onClick={handleClick}
      >
        {tracking ? <IconBellFilled size={20} /> : <IconBell size={20} />}
      </LegacyActionIcon>
    </Tooltip>
  );
}
