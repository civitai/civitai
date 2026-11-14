import { Button, Stack, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconArrowsMove, IconClock, IconHanger } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { HatStats } from '~/components/Events/ScoredEvent/HatStats';
import HatTurfVideoModal from '~/components/Events/ScoredEvent/HatTurfVideoModal';
import { EVENT_CARD_SURFACE } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';

export type MyHat = RouterOutput['event']['getMyHats'][number];
type PlacementStats = NonNullable<RouterOutput['event']['getMyHatPlacementStats']>[number];

const ENTITY_NOUN: Record<string, string> = { Image: 'image', Model: 'model', Article: 'article' };
const plural = (n: number, word: string) => `${abbreviateNumber(n)} ${word}${n === 1 ? '' : 's'}`;

// Not overflow-hidden: the worn hat sits on the picture's corner and reaches past the card, as on
// a feed card. The picture rounds its own top corners to the card's (8px less the 1px border).
const CARD = `flex flex-col rounded-lg border border-solid border-gray-3 dark:border-dark-4 ${EVENT_CARD_SURFACE}`;
const PICTURE_RADIUS = 'rounded-t-[7px]';

/** One of your hats: where it is worn, its score, and Place it / Move. Without `onPlace` it shows no action. */
export function MyHatCard({
  hat,
  color,
  minutesLeft,
  onPlace,
  placement,
}: {
  hat: MyHat;
  color: string;
  /** Minutes until the move cooldown ends. */
  minutesLeft: number;
  onPlace?: () => void;
  /** What the hat has earned where it is now, since it went on. */
  placement?: PlacementStats;
}) {
  const image = hat.placedOn?.image;
  return (
    <div className={CARD} data-testid="my-hat">
      {/* Move takes the free top-right corner; the worn hat sits on the top-left. */}
      <div className="relative">
        {hat.placedOn ? (
          <EventContentThumb
            entityType={hat.placedOn.entityType}
            image={hat.placedOn.image}
            hat={hat.data}
            className={PICTURE_RADIUS}
            wornOn={{
              entityType: hat.placedOn.entityType as CosmeticEntity,
              entityId: hat.placedOn.entityId,
            }}
            onPlay={
              image
                ? () =>
                    dialogStore.trigger({
                      component: HatTurfVideoModal,
                      props: { video: image.url, title: image.name ?? 'Video' },
                    })
                : undefined
            }
          />
        ) : (
          <div
            className={`grid aspect-[4/5] w-full place-items-center bg-gray-1 dark:bg-dark-7 ${PICTURE_RADIUS}`}
          >
            <HatArt url={hat.data.url} color={color} width={192} className="!bg-transparent" />
          </div>
        )}
        {/* Not gated on the event having ended: hats can still be moved afterwards. */}
        {onPlace && (
          <Button
            size="compact-xs"
            radius="xl"
            variant={hat.placedOn ? 'default' : 'filled'}
            leftSection={hat.placedOn ? <IconArrowsMove size={14} /> : <IconHanger size={14} />}
            disabled={minutesLeft > 0}
            onClick={onPlace}
            className={
              hat.placedOn
                ? 'absolute right-2 top-2 shadow-md'
                : 'absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md'
            }
          >
            {hat.placedOn ? 'Move' : 'Place it'}
          </Button>
        )}
      </div>
      <Stack gap={8} p="sm" className="flex-1">
        <Text fw={700} size="sm" truncate>
          {hat.name}
        </Text>
        <div className="mt-auto">
          <HatStats stats={hat} color={color} compact />
        </div>
        {hat.placedOn && placement && (
          <Tooltip
            label="Updates every few minutes and runs up to about 20 minutes behind. Counts views from signed-in people."
            multiline
            w={240}
            withArrow
          >
            <Text size="xs" c="dimmed" data-testid="my-hat-placement-stats">
              On this {ENTITY_NOUN[hat.placedOn.entityType] ?? 'post'}:{' '}
              {plural(placement.views, 'view')} · {abbreviateNumber(placement.points)} pts since you
              placed it
            </Text>
          </Tooltip>
        )}
        {minutesLeft > 0 && (
          <Text size="xs" c="dimmed">
            <IconClock size={12} className="inline align-[-1px]" /> Can move in {minutesLeft} min
          </Text>
        )}
      </Stack>
    </div>
  );
}
