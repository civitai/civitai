import { Badge, Card, Loader, ScrollArea, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronLeft, IconHammer } from '@tabler/icons-react';
import { useState } from 'react';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { useInquisitorTools, useQueryImageRaters } from '~/components/Games/KnightsNewOrder.utils';
import { PlayerStats } from '~/components/Games/PlayerCard';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function NewOrderImageRatings({ imageId, imageNsfwLevel }: Props) {
  const [opened, setOpened] = useState(false);

  const { smitePlayer, applyingSmite, smitePayload } = useInquisitorTools();
  const { raters, isLoading } = useQueryImageRaters({ imageId });
  const nothingFound = raters.Knight?.length === 0 && raters.Templar?.length === 0;

  return (
    <div className={`fixed right-0 top-1/2 -translate-y-1/2 ${opened ? 'z-30' : 'z-0'}`}>
      <div
        className={`relative flex items-center transition-transform duration-300 ${
          opened ? 'translate-x-0' : 'translate-x-[350px]'
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
          className={`flex w-[350px] flex-col gap-2 overflow-hidden rounded-l-lg bg-dark-7 p-4 transition-all duration-300 ${
            opened ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <h2 className="text-lg font-semibold text-white">Raters</h2>
          <ScrollArea.Autosize mah={400}>
            {isLoading ? (
              <div className="flex size-full items-center justify-center">
                <Loader />
              </div>
            ) : nothingFound ? (
              <div className="flex size-full items-center justify-center p-4">
                <Text c="dimmed">There are no raters yet</Text>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[NewOrderRankType.Knight, NewOrderRankType.Templar].map((rankType) => {
                  const ratersForRank = raters[rankType] ?? [];

                  return ratersForRank.length > 0 ? (
                    <div key={rankType}>
                      <h3 className="mb-1 text-sm font-bold text-white">{rankType}s</h3>
                      {ratersForRank.map(({ player, rating }) => {
                        const loading = smitePayload?.playerId === player.id && applyingSmite;

                        return (
                          <Card key={player.id} className="mb-2 flex flex-col gap-1">
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
                                <LegacyActionIcon
                                  color="red"
                                  variant="filled"
                                  onClick={() => smitePlayer({ playerId: player.id, imageId })}
                                  loading={loading}
                                >
                                  <IconHammer size={18} />
                                </LegacyActionIcon>
                              </Tooltip>
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                  ) : null;
                })}
              </div>
            )}
          </ScrollArea.Autosize>
        </div>
      </div>
    </div>
  );
}

type Props = {
  imageId: number;
  imageNsfwLevel: NsfwLevel;
};
