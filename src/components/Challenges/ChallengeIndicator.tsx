import { Indicator } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { useGetActiveChallenges, dismissChallenges } from '~/components/Challenges/challenge.utils';
import { ChallengeInvitation } from '~/components/Challenges/ChallengeInvitation';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useEffect } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ChallengeIndicator() {
  const { challenges, loading } = useGetActiveChallenges();

  const handleOpen = () => {
    dialogStore.trigger({
      component: ChallengeInvitation,
      props: { onClose: () => dismissChallenges(challenges.map((x) => x.challengeId)) },
    });
  };

  // remove old local storage keys
  useEffect(() => {
    const arr: string[] = []; // Array to hold the keys
    // Iterate over localStorage and insert the keys that meet the condition into arr
    for (let i = 0; i < localStorage.length; i++) {
      const val = localStorage.key(i);
      if (val && val.substring(0, 25) === 'daily-challenge-dismissed') {
        arr.push(val);
      }
    }

    // Iterate over arr and remove the items by key
    for (let i = 0; i < arr.length; i++) {
      localStorage.removeItem(arr[i]);
    }
  }, []);

  // Hide the indicator if there are no active challenges
  if (!loading && challenges.length === 0) {
    return null;
  }

  const futureChallenge = !!challenges?.find((x) => !x.endsToday && !x.dismissed);
  const hasUnseen = !!challenges.filter((x) => !x.dismissed).length;

  return (
    <Indicator color="red" size={12} disabled={!hasUnseen} inline>
      <LegacyActionIcon
        size="lg"
        className={clsx(hasUnseen && 'animate-wiggle')}
        color={hasUnseen ? (futureChallenge ? 'yellow' : 'teal') : 'dark'}
        variant={hasUnseen ? 'filled' : 'transparent'}
        onClick={handleOpen}
      >
        <IconTrophy size={20} color="currentColor" />
      </LegacyActionIcon>
    </Indicator>
  );
}
