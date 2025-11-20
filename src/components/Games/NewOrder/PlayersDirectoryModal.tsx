import {
  ActionIcon,
  Button,
  Card,
  CloseButton,
  Loader,
  LoadingOverlay,
  Modal,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconChevronRight,
  IconHammer,
  IconHealthRecognition,
  IconSearch,
  IconSkull,
} from '@tabler/icons-react';
import { useState } from 'react';
import { ClearableTextInput } from '~/components/ClearableTextInput/ClearableTextInput';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useInquisitorTools } from '~/components/Games/NewOrder/hooks/useInquisitorTools';
import { useQueryPlayersInfinite } from '~/components/Games/NewOrder/hooks/useQueryPlayersInfinite';
import { PlayerStats } from '~/components/Games/PlayerCard';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetPlayersItem } from '~/types/router';

export default function PlayersDirectoryModal() {
  const dialog = useDialogContext();
  const [debouncedSearch, setDebouncedSearch] = useDebouncedState<string | undefined>(
    undefined,
    200
  );
  const [playerId, setPlayerId] = useState<number | undefined>(undefined);

  const { players, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    useQueryPlayersInfinite({ query: debouncedSearch });

  const selectedPlayer = playerId ? players.find((player) => player.id === playerId) : undefined;

  return (
    <Modal {...dialog} withCloseButton={false} padding={0}>
      <div className="sticky top-[-48px] z-30 flex flex-col gap-4 bg-gray-0 p-5 dark:bg-dark-7">
        <div className="flex items-center justify-between">
          <h1 className="text-xl">Players Directory</h1>
          <CloseButton title="Close player directory" onClick={dialog.onClose} />
        </div>
        {playerId ? (
          <button
            className="rounded-sm p-2 hover:bg-gray-1 dark:hover:bg-dark-5"
            onClick={() => setPlayerId(undefined)}
          >
            <div className="flex items-center gap-2">
              <IconArrowLeft />
              <span className="text-sm">Back to players</span>
            </div>
          </button>
        ) : (
          <ClearableTextInput
            className="w-full"
            placeholder="Search for players..."
            type="search"
            leftSection={<IconSearch size={16} />}
            onChange={(e) => setDebouncedSearch(e.currentTarget.value || undefined)}
          />
        )}
      </div>
      <div className="px-5 pb-5">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader />
          </div>
        ) : selectedPlayer ? (
          <PlayerDetails player={selectedPlayer} />
        ) : players?.length ? (
          <div className="flex flex-col gap-2">
            <LoadingOverlay visible={isFetching || isRefetching} />
            {players.map((player) => (
              <button
                key={player.id}
                className="flex flex-nowrap items-center justify-between rounded-md p-2 hover:bg-gray-1 dark:hover:bg-dark-5"
                onClick={() => setPlayerId(player.id)}
              >
                <UserAvatar
                  user={player}
                  avatarSize="md"
                  subText={<PlayerStats stats={{ ...player.stats }} showSmiteCount />}
                  withUsername
                />
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

function PlayerDetails({ player }: { player: GetPlayersItem }) {
  const features = useFeatureFlags();
  const { cleanseSmite, cleansingSmite, cleansePayload, resetPlayer, resettingPlayer } =
    useInquisitorTools();

  const handleResetPlayerClick = () => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Reset Player',
        message: `Are you sure you want to reset ${player.username}? The player will be notified and this action cannot be undone.`,
        labels: { cancel: 'Cancel', confirm: 'Reset Player' },
        confirmProps: { color: 'red' },
        onConfirm: async () => resetPlayer({ playerId: player.id }),
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <UserAvatar
        user={player}
        avatarSize="md"
        subText={<PlayerStats stats={{ ...player.stats }} showSmiteCount />}
        withUsername
      />
      {features.newOrderReset && (
        <Button
          size="sm"
          color="red"
          leftSection={<IconSkull className="size-5" />}
          loading={resettingPlayer}
          onClick={handleResetPlayerClick}
          fullWidth
        >
          Reset player career
        </Button>
      )}
      <p className="text-lg font-semibold">Active Smites</p>
      {player.activeSmites.length ? (
        player.activeSmites.map((smite) => {
          const loading = cleansePayload?.id === smite.id && cleansingSmite;

          return (
            <Card key={smite.id}>
              <div className="flex flex-nowrap items-center justify-between gap-2">
                <div className="flex flex-nowrap gap-2">
                  {/* @ts-ignore: transparent variant works */}
                  <ThemeIcon size="lg" variant="transparent">
                    <IconHammer />
                  </ThemeIcon>
                  <div className="flex flex-col items-center justify-center gap-1">
                    {smite.reason && <p>Reason: {smite.reason}</p>}
                    <div className="flex gap-1">
                      <span>Size: {smite.size}</span> | <span>Remaining: {smite.remaining}</span>
                    </div>
                  </div>
                </div>
                <Tooltip label="Cleanse smite" withinPortal>
                  <LegacyActionIcon
                    size="lg"
                    color="pink"
                    variant="filled"
                    onClick={() =>
                      cleanseSmite({
                        id: smite.id,
                        playerId: player.id,
                        cleansedReason: 'Cleared by inquisitor',
                      })
                    }
                    loading={loading}
                  >
                    <IconHealthRecognition />
                  </LegacyActionIcon>
                </Tooltip>
              </div>
            </Card>
          );
        })
      ) : (
        <p className="text-sm text-gray-5 dark:text-dark-3">
          No active smites found for this player.
        </p>
      )}
    </div>
  );
}
