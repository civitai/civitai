import { Drawer, Group, Navbar, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconCrown, IconHistory, IconSkull, IconUsers } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  openJudgmentHistoryModal,
  openPlayersDirectoryModal,
  useJoinKnightsNewOrder,
} from '~/components/Games/KnightsNewOrder.utils';
import { PlayerCard } from '~/components/Games/PlayerCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

export function NewOrderSidebar() {
  const currentUser = useCurrentUser();
  const { playerData, resetCareer } = useJoinKnightsNewOrder();
  const mobile = useIsMobile({ breakpoint: 'md' });

  const [opened, setOpened] = useState(false);

  const content = (
    <Navbar p="md" width={{ xs: 300, sm: 360 }} zIndex={1} withBorder>
      <Navbar.Section className="border-b border-gray-200 pb-4 dark:border-b-dark-4">
        {playerData && currentUser && (
          <PlayerCard
            {...playerData.stats}
            user={currentUser}
            rank={playerData.rank}
            showStats={playerData.rank.type !== NewOrderRankType.Acolyte}
          />
        )}
      </Navbar.Section>
      <Navbar.Section mt="md" grow>
        <div className="flex flex-col">
          <UnstyledButton
            className="w-full rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
            onClick={() => openJudgmentHistoryModal()}
          >
            <Group>
              <ThemeIcon size="xl" variant="light">
                <IconHistory />
              </ThemeIcon>
              Judgment History
            </Group>
          </UnstyledButton>
          {currentUser?.isModerator && (
            <UnstyledButton
              className="w-full rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
              onClick={() => openPlayersDirectoryModal()}
            >
              <Group>
                <ThemeIcon size="xl" variant="light" color="lime">
                  <IconUsers />
                </ThemeIcon>
                Players Directory
              </Group>
            </UnstyledButton>
          )}
          <UnstyledButton
            component={Link}
            className="w-full rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
            href="/leaderboard/knights-new-order"
          >
            <Group>
              <ThemeIcon size="xl" color="yellow" variant="light">
                <IconCrown />
              </ThemeIcon>
              View Leaderboard
            </Group>
          </UnstyledButton>
          <UnstyledButton
            className="w-full rounded-md p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
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
          >
            <Group>
              <ThemeIcon size="xl" color="red" variant="light">
                <IconSkull />
              </ThemeIcon>
              Restart Career
            </Group>
          </UnstyledButton>
        </div>
      </Navbar.Section>
    </Navbar>
  );

  return mobile ? (
    <>
      {playerData && currentUser && (
        <PlayerCard
          {...playerData.stats}
          user={currentUser}
          rank={playerData.rank}
          showStats={playerData.rank.type !== NewOrderRankType.Acolyte}
          onClick={() => setOpened((o) => !o)}
          className="w-full cursor-pointer p-4 dark:bg-dark-6"
          withBorder
        />
      )}
      <Drawer opened={opened} onClose={() => setOpened(false)} withCloseButton={false}>
        {content}
      </Drawer>
    </>
  ) : (
    content
  );
}
