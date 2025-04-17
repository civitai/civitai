import { ActionIcon, Badge, UnstyledButton } from '@mantine/core';
import { IconChevronLeft, IconHammer } from '@tabler/icons-react';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { GetPlayer } from '~/types/router';
import { useState } from 'react';
import { useInquisitorTools } from '~/components/Games/KnightsNewOrder.utils';

export function NewOrderImageRatings({ imageId, imageNsfwLevel, ratings }: Props) {
  const [opened, setOpened] = useState(false);

  const { smitePlayer, applyingSmite } = useInquisitorTools();

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
          className={`flex w-[300px] flex-col gap-4 overflow-hidden rounded-l-lg bg-dark-7 p-4 transition-all duration-300 ${
            opened ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <h2 className="text-lg font-semibold text-white">Raters</h2>
          <div className="flex flex-col gap-2">
            {ratings?.map(({ player, rating }) => (
              <div key={player.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-400">{player.username}</span>
                    <Badge
                      size="xs"
                      className={`${rating === imageNsfwLevel ? 'text-green-500' : 'text-red-500'}`}
                    >
                      {browsingLevelLabels[rating] ?? '?'}
                    </Badge>
                  </div>
                  <ActionIcon
                    size="sm"
                    color="red"
                    onClick={() => smitePlayer({ playerId: player.id, imageId })}
                  >
                    <IconHammer />
                  </ActionIcon>
                </div>
              </div>
            ))}
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
