import { ActionIcon, Indicator } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect } from 'react';
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
    defaultValue: true,
    getInitialValueInEffect: true,
  });

  const handleOpen = () => {
    dialogStore.trigger({
      component: ChallengeInvitation,
      props: { onClose: () => setDismissed(true) },
    });
  };
  useEffect(() => {
    if (challenge?.articleId) {
      const localDismissed = window.localStorage.getItem(storageKey) === 'true';
      if (localDismissed !== dismissed) {
        setDismissed(localDismissed);
      }
    }
  }, [challenge?.articleId, storageKey]);

  return (
    <Indicator color="red" size={12} disabled={dismissed} dot inline>
      <ActionIcon
        size="lg"
        className={clsx(!dismissed && 'animate-wiggle')}
        color={!dismissed ? 'teal' : 'dark'}
        variant={!dismissed ? 'filled' : 'transparent'}
        onClick={handleOpen}
      >
        <IconTrophy size={20} color="currentColor" />
      </ActionIcon>
    </Indicator>
  );
}
