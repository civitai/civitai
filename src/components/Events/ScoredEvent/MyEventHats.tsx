import { Button, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArrowsMove, IconClock, IconHanger, IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import { HatStats } from '~/components/Events/ScoredEvent/HatStats';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import {
  EVENT_CARD_SURFACE,
  minutesUntilMovable,
} from '~/components/Events/ScoredEvent/scored-event.utils';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';

type MyHat = RouterOutput['event']['getMyHats'][number];

// Not overflow-hidden: the worn hat sits on the picture's corner and reaches past the card, as on
// a feed card. The picture rounds its own top corners to the card's (8px less the 1px border).
const CARD = `flex flex-col rounded-lg border border-solid border-gray-3 dark:border-dark-4 ${EVENT_CARD_SURFACE}`;
const PICTURE_RADIUS = 'rounded-t-[7px]';
// The room left of the first column is the page's gutter: the event page's lg Container's padding,
// plus its margin once the scroll area (the nearest CSS container) is wider. A worn hat moves in
// rather than reach past it.
const HAT_ROOM =
  'calc(max(0px, (100cqw - var(--container-size-lg)) / 2) + var(--mantine-spacing-md))';

export function MyEventHats({
  event,
  hats,
  fetchedAt,
  teamColor,
  ended,
}: {
  event: string;
  hats: MyHat[];
  /** When `hats` arrived, on the browser's clock (the query's dataUpdatedAt). */
  fetchedAt: number;
  teamColor: string;
  ended: boolean;
}) {
  const total = hats.reduce((sum, h) => sum + h.points, 0);
  // Re-reads the clock every half minute, so a hat's Move button unlocks when its cooldown ends.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const openPicker = (hat: MyHat) =>
    dialogStore.trigger({
      component: PlaceHatModal,
      props: { event, hat, myHats: hats },
    });

  return (
    <Stack gap="md">
      <EventSectionHeading
        icon={IconHanger}
        title="Your hats"
        color={teamColor}
        subtitle={
          <>
            {hats.length} {hats.length === 1 ? 'hat' : 'hats'} ·{' '}
            <Text component="span" fw={700} c={teamColor}>
              {numberWithCommas(total)}
            </Text>{' '}
            points for your team
          </>
        }
      />

      {/* Equal rows, so the "Get another hat" card is a hat card's size even alone on its row. */}
      <SimpleGrid
        cols={{ base: 2, md: 3, lg: 4 }}
        spacing="md"
        style={{ gridAutoRows: '1fr', '--event-decoration-allowance': HAT_ROOM } as CSSProperties}
        data-testid="my-hats-grid"
      >
        {hats.map((hat) => {
          const minutesLeft = minutesUntilMovable(
            hat.moveCooldownLeftMs,
            now.getTime() - fetchedAt
          );
          return (
            <div key={`${hat.cosmeticId}:${hat.claimKey}`} className={CARD} data-testid="my-hat">
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
                    <HatArt
                      url={hat.data.url}
                      color={teamColor}
                      width={192}
                      className="!bg-transparent"
                    />
                  </div>
                )}
                {/* Hats are kept after the event, so they can still be moved then. */}
                <Button
                  size="compact-xs"
                  radius="xl"
                  variant={hat.placedOn ? 'default' : 'filled'}
                  leftSection={
                    hat.placedOn ? <IconArrowsMove size={14} /> : <IconHanger size={14} />
                  }
                  disabled={minutesLeft > 0}
                  onClick={() => openPicker(hat)}
                  className={
                    hat.placedOn
                      ? 'absolute right-2 top-2 shadow-md'
                      : 'absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md'
                  }
                >
                  {hat.placedOn ? 'Move' : 'Place it'}
                </Button>
              </div>
              <Stack gap={8} p="sm" className="flex-1">
                <Stack gap={0} className="min-w-0">
                  <Text fw={700} size="sm" truncate>
                    {hat.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {hat.placedOn
                      ? `On ${
                          hat.placedOn.title ?? `your ${hat.placedOn.entityType.toLowerCase()}`
                        }`
                      : 'Not on anything yet'}
                  </Text>
                </Stack>
                <div className="mt-auto">
                  <HatStats stats={hat} color={teamColor} compact />
                </div>
                {minutesLeft > 0 && (
                  <Text size="xs" c="dimmed">
                    <IconClock size={12} className="inline align-[-1px]" /> Can move in{' '}
                    {minutesLeft} min
                  </Text>
                )}
              </Stack>
            </div>
          );
        })}
        {!ended && (
          <a
            href="#team-hats"
            className="flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-4 p-4 text-center no-underline hover:border-gray-6 dark:border-dark-3 dark:hover:border-dark-1"
            data-testid="get-another-hat"
          >
            <IconPlus size={24} className="text-dimmed" />
            <Text fw={700} size="sm">
              Get another hat
            </Text>
            <Text size="xs" c="dimmed">
              One more post scoring for your team.
            </Text>
          </a>
        )}
      </SimpleGrid>
    </Stack>
  );
}
