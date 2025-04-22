import { ActionIcon, Badge, Card, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronLeft, IconHammer } from '@tabler/icons-react';
import { useState } from 'react';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { GetPlayer } from '~/types/router';
import { useInquisitorTools } from '~/components/Games/KnightsNewOrder.utils';
import { PlayerStats } from '~/components/Games/PlayerCard';

export function NewOrderImageRatings({ imageId, imageNsfwLevel, ratings }: Props) {
  const [opened, setOpened] = useState(false);

  const { smitePlayer, applyingSmite, smitePayload } = useInquisitorTools();

  if (!ratings || ratings.length === 0) return null;

  return (
    <div className="fixed right-0 top-1/2 z-50 -translate-y-1/2">
      <div
        className={`relative flex items-center transition-transform duration-300 ${
          opened ? 'translate-x-0' : 'translate-x-[300px]'
        }`}
      >
        <UnstyledButton
          className="flex size-10 items-center justify-center rounded-l-lg bg-dark-7 p-2 transition-all duration-300 hover:bg-dark-5"
          onClick={() => setOpened((o) => !o)}
        >
          <IconChevronLeft
            size={32}
            className={`text-white transition-transform duration-300 ${opened ? 'rotate-180' : ''}`}
          />
        </UnstyledButton>
        <div
          className={`flex w-[300px] flex-col gap-2 overflow-hidden rounded-l-lg bg-dark-7 p-4 transition-all duration-300 ${
            opened ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <h2 className="text-lg font-semibold text-white">Raters</h2>
          <div className="flex flex-col gap-2">
            {ratings?.map(({ player, rating }) => {
              const loading = smitePayload?.playerId === player.id && applyingSmite;

              return (
                <Card key={player.id} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{player.username}</span>
                        <Badge
                          className={`${
                            rating === imageNsfwLevel ? 'text-green-500' : 'text-red-500'
                          }`}
                        >
                          {browsingLevelLabels[rating] ?? '?'}
                        </Badge>
                      </div>
                      <PlayerStats stats={{ ...player.stats }} size="sm" showSmiteCount />
                    </div>
                    <Tooltip label="Smite player" withinPortal>
                      <ActionIcon
                        color="red"
                        variant="filled"
                        onClick={() => smitePlayer({ playerId: player.id, imageId })}
                        loading={loading}
                      >
                        <IconHammer size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

type Props = {
  imageId: number;
  imageNsfwLevel: NsfwLevel;
  ratings: Array<{ player: GetPlayer; rating: NsfwLevel }> | null;
};
