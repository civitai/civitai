import { Button } from '@mantine/core';
import { IconCrown, IconHistory, IconSkull } from '@tabler/icons-react';
import Link from 'next/link';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  openJudgementHistoryModal,
  useJoinKnightsNewOrder,
} from '~/components/Games/KnightsNewOrder.utils';

export function MenuActions() {
  const { resetCareer } = useJoinKnightsNewOrder();

  return (
    <div className="mt-2 flex flex-col gap-2">
      <Button
        variant="light"
        leftIcon={<IconHistory />}
        onClick={() => openJudgementHistoryModal()}
        fullWidth
      >
        Judgement History
      </Button>
      <Button
        component={Link}
        href="/leaderboard/knights-of-new-order"
        color="yellow"
        variant="light"
        leftIcon={<IconCrown />}
        fullWidth
      >
        View Leaderboard
      </Button>
      <Button
        color="red"
        variant="light"
        leftIcon={<IconSkull />}
        onClick={() => {
          dialogStore.trigger({
            component: ConfirmDialog,
            props: {
              title: 'Are you sure?',
              message: 'This will restart your career and reset all your progress.',
              labels: { cancel: 'No', confirm: `Yes, I'm sure` },
              onConfirm: async () => await resetCareer(),
              confirmProps: { color: 'red' },
            },
          });
        }}
        fullWidth
      >
        Restart Career
      </Button>
    </div>
  );
}
