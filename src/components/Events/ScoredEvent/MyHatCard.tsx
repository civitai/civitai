import { Button, Stack, Text } from '@mantine/core';
import { IconArrowsMove, IconClock, IconHanger } from '@tabler/icons-react';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { HatStats } from '~/components/Events/ScoredEvent/HatStats';
import { EVENT_CARD_SURFACE } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';

export type MyHat = RouterOutput['event']['getMyHats'][number];

// Not overflow-hidden: the worn hat sits on the picture's corner and reaches past the card, as on
// a feed card. The picture rounds its own top corners to the card's (8px less the 1px border).
const CARD = `flex flex-col rounded-lg border border-solid border-gray-3 dark:border-dark-4 ${EVENT_CARD_SURFACE}`;
const PICTURE_RADIUS = 'rounded-t-[7px]';

/**
 * One of your hats: where it is worn, its score, and Place it / Move. Shared by the event page's
 * "Your hats" and the Inventory's Hats page. Without `onPlace` it shows no action.
 */
export function MyHatCard({
  hat,
  color,
  minutesLeft,
  onPlace,
}: {
  hat: MyHat;
  color: string;
  /** Until the move cooldown ends; the action is disabled while above zero. */
  minutesLeft: number;
  onPlace?: () => void;
}) {
  return (
    <div className={CARD} data-testid="my-hat">
      {/* The action sits on the picture: Move in the free top-right corner (the hat wears
          the top-left), Place it in the middle of an empty frame. */}
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
          />
        ) : (
          <div
            className={`grid aspect-[4/5] w-full place-items-center bg-gray-1 dark:bg-dark-7 ${PICTURE_RADIUS}`}
          >
            <HatArt url={hat.data.url} color={color} width={192} className="!bg-transparent" />
          </div>
        )}
        {/* Hats are kept after the event, so they can still be moved then. */}
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
        {minutesLeft > 0 && (
          <Text size="xs" c="dimmed">
            <IconClock size={12} className="inline align-[-1px]" /> Can move in {minutesLeft} min
          </Text>
        )}
      </Stack>
    </div>
  );
}
