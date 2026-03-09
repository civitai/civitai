import { Alert } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import { useWinnerCooldownStatus } from '~/components/Challenge/challenge.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

type Props = {
  challengeId: number;
  status: ChallengeStatus;
};

export function CooldownBanner({ challengeId, status }: Props) {
  const currentUser = useCurrentUser();
  const isActive = status === ChallengeStatus.Active;

  const { data: cooldownStatus } = useWinnerCooldownStatus(challengeId, {
    enabled: !!currentUser && isActive,
  });

  if (!cooldownStatus?.onCooldown || !cooldownStatus.cooldownEndsAt) return null;

  return (
    <Alert icon={<IconInfoCircle size={20} />} color="blue" variant="light" radius="md">
      You recently won a challenge! You can still submit entries, but you&apos;re on a winner
      cooldown until <strong>{formatDate(cooldownStatus.cooldownEndsAt, 'MMM D, YYYY')}</strong>.
      Your entries won&apos;t be eligible for prizes this time.
    </Alert>
  );
}
