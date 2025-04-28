import { Group, Navbar, Popover, ThemeIcon } from '@mantine/core';
import { IconChevronDown, IconCrown, IconHistory, IconSkull, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
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

  const header =
    playerData && currentUser ? (
      <PlayerCard
        {...playerData.stats}
        user={currentUser}
        rank={playerData.rank}
        showStats={playerData.rank.type !== NewOrderRankType.Acolyte}
        className={clsx(
          'w-full rounded-b-none p-4 @md:rounded-sm',
          opened ? 'bg-gray-1 dark:bg-dark-5' : 'dark:bg-dark-6'
        )}
        withBorder
      />
    ) : null;

  const content = (
    <div className="flex flex-col">
      <button
        className="w-full rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
        onClick={() => openJudgmentHistoryModal()}
      >
        <Group>
          <ThemeIcon size="xl" variant="light">
            <IconHistory />
          </ThemeIcon>
          Judgment History
        </Group>
      </button>
      {currentUser?.isModerator && (
        <button
          className="w-full rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
          onClick={() => openPlayersDirectoryModal()}
        >
          <Group>
            <ThemeIcon size="xl" variant="light" color="lime">
              <IconUsers />
            </ThemeIcon>
            Players Directory
          </Group>
        </button>
      )}
      <Link
        className="w-full cursor-pointer rounded-[4px] p-3 hover:bg-gray-0 dark:hover:bg-dark-6"
        href="/leaderboard/knights-new-order"
      >
        <Group>
          <ThemeIcon size="xl" color="yellow" variant="light">
            <IconCrown />
          </ThemeIcon>
          View Leaderboard
        </Group>
      </Link>
      <button
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
      </button>
    </div>
  );

  return mobile ? (
    <div className="flex flex-col">
      {header}
      <Popover
        position="bottom"
        transition="scale-y"
        width="calc(100% - 32px)"
        onChange={setOpened}
        zIndex={40}
      >
        <Popover.Target>
          <button
            className={clsx(
              'z-10 w-full justify-items-center border border-t-0 p-1 dark:border-dark-4',
              opened ? 'bg-gray-1 dark:bg-dark-5' : 'dark:bg-dark-6'
            )}
          >
            <IconChevronDown
              size={16}
              className={clsx('transition-transform', opened ? 'rotate-180' : '')}
            />
          </button>
        </Popover.Target>
        <Popover.Dropdown p={0}>{content}</Popover.Dropdown>
      </Popover>
    </div>
  ) : (
    <Navbar p="md" h="100%" width={{ xs: 300, sm: 360 }} zIndex={1} withBorder>
      <Navbar.Section className="border-b border-gray-200 pb-4 dark:border-b-dark-4">
        {header}
      </Navbar.Section>
      <Navbar.Section mt="md" grow>
        {content}
      </Navbar.Section>
    </Navbar>
  );
}
