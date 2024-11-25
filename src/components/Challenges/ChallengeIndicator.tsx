import { ActionIcon, Indicator } from '@mantine/core';
import { IconMountain } from '@tabler/icons-react';
import clsx from 'clsx';
import { useQueryCurrentChallenge } from '~/components/Challenges/challenge.utils';
import { ChallengeInvitation } from '~/components/Challenges/ChallengeInvitation';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useStorage } from '~/hooks/useStorage';

export function ChallengeIndicator() {
  const { challenge } = useQueryCurrentChallenge();
  const storageKey = `daily-challenge-dismissed-${challenge?.articleId}`;
  const [dismissed, setDismissed] = useStorage({
    type: 'localStorage',
    key: storageKey,
    defaultValue:
      typeof window !== 'undefined' ? window?.localStorage?.getItem(storageKey) === 'true' : false,
    getInitialValueInEffect: true,
  });

  const handleOpen = () => {
    dialogStore.trigger({
      component: ChallengeInvitation,
      props: { onClose: () => setDismissed(true) },
    });
  };

  return (
    <Indicator color="red" size={12} disabled={dismissed} dot inline>
      <ActionIcon
        size="lg"
        className={clsx(!dismissed && 'animate-wiggle')}
        color={!dismissed ? 'yellow' : 'dark'}
        variant={!dismissed ? 'filled' : 'transparent'}
        onClick={handleOpen}
      >
        <IconMountain size={20} color="currentColor" />
      </ActionIcon>
    </Indicator>
  );
}
