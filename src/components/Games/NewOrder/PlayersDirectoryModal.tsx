import { ActionIcon, CloseButton, Loader, LoadingOverlay, Modal, TextInput } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconChevronRight, IconHammerOff, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { ClearableTextInput } from '~/components/ClearableTextInput/ClearableTextInput';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import {
  useInquisitorTools,
  useQueryPlayersInfinite,
} from '~/components/Games/KnightsNewOrder.utils';
import { PlayerStats } from '~/components/Games/PlayerCard';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { NoContent } from '~/components/NoContent/NoContent';

export default function PlayersDirectoryModal() {
  const dialog = useDialogContext();
  const [debouncedSearch, setDebouncedSearch] = useDebouncedState<string | undefined>(
    undefined,
    200
  );
  const [selectedPlayer, setSelectedPlayer] = useState<(typeof players)[number] | undefined>(
    undefined
  );

  const { players, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    useQueryPlayersInfinite({ query: debouncedSearch });

  const { cleanseSmite, cleansingSmite } = useInquisitorTools();

  return (
    <Modal {...dialog} withCloseButton={false} padding={0}>
      <div className="sticky top-[-48px] z-30 flex flex-col gap-4 bg-gray-0 p-5 dark:bg-dark-7">
        <div className="flex items-center justify-between">
          <h1 className="text-xl">Players Directory</h1>
          <CloseButton title="Close player directory" onClick={dialog.onClose} />
        </div>
        <ClearableTextInput
          className="w-full"
          placeholder="Search for players..."
          type="search"
          icon={<IconSearch size={16} />}
          onChange={(e) => setDebouncedSearch(e.currentTarget.value || undefined)}
        />
      </div>
      <div className="px-5 pb-5">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader />
          </div>
        ) : players?.length ? (
          <div className="flex flex-col gap-2">
            <LoadingOverlay visible={isFetching || isRefetching} />
            {players.map((player) => (
              <button
                key={player.id}
                className="flex flex-nowrap items-center justify-between rounded-md p-2 hover:bg-gray-1 dark:hover:bg-dark-5"
                onClick={() => setSelectedPlayer(player)}
              >
                <div className="flex flex-1 flex-col gap-1">
                  <span className="flex-1 truncate text-start text-sm font-semibold text-gray-900 dark:text-gray-200">
                    {player.username}
                  </span>
                  <PlayerStats stats={{ ...player.stats, gold: player.stats.blessedBuzz }} />
                </div>
                <IconChevronRight />
              </button>
            ))}

            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isFetching}
                style={{ gridColumn: '1/-1' }}
              >
                <div className="mt-4 flex h-full items-center justify-center p-6">
                  <Loader />
                </div>
              </InViewLoader>
            )}
          </div>
        ) : (
          <NoContent title="No players found" />
        )}
      </div>
    </Modal>
  );
}
