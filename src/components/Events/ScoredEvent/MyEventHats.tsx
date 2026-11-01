import { Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconHanger, IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import type { MyHat } from '~/components/Events/ScoredEvent/MyHatCard';
import { MyHatCard } from '~/components/Events/ScoredEvent/MyHatCard';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { minutesUntilMovable } from '~/components/Events/ScoredEvent/scored-event.utils';
import { MysteryBoxCard } from '~/components/MysteryBox/MysteryBoxCard';
import { useEventMysteryBoxes } from '~/components/MysteryBox/useEventMysteryBoxes';
import { numberWithCommas } from '~/utils/number-helpers';

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
  const boxes = useEventMysteryBoxes(event);
  const boxPrice = boxes.find((box) => box.listing)?.listing?.unitAmount;
  // Once the event ends the shelf is gone, and an unopened box still opens: it shows here.
  const heldBoxes = ended ? boxes.filter((box) => box.heldBoxItemIds.length) : [];
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
  const minutesLeft = (hat: MyHat) =>
    minutesUntilMovable(hat.moveCooldownLeftMs, now.getTime() - fetchedAt);
  const idleHat =
    !ended && hats.every((h) => !h.placedOn) ? hats.find((h) => minutesLeft(h) === 0) : undefined;

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

      {idleHat && (
        <Paper
          withBorder
          p="md"
          radius="md"
          style={{ borderColor: teamColor }}
          data-testid="idle-hat-cta"
        >
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Stack gap={2}>
              <Text fw={700}>Put your hat on something</Text>
              <Text size="sm" c="dimmed">
                A hat scores for your team once it&apos;s on one of your images, models or articles.
              </Text>
            </Stack>
            <Button
              color={teamColor}
              leftSection={<IconHanger size={16} />}
              onClick={() => openPicker(idleHat)}
            >
              Place your hat
            </Button>
          </Group>
        </Paper>
      )}

      {heldBoxes.map((box) => (
        <MysteryBoxCard key={box.boxDefinitionId} event={event} view={box} color={teamColor} />
      ))}

      {/* Equal rows, so the "Get another hat" card is a hat card's size even alone on its row. */}
      <SimpleGrid
        cols={{ base: 2, md: 3, lg: 4 }}
        spacing="md"
        style={{ gridAutoRows: '1fr', '--event-decoration-allowance': HAT_ROOM } as CSSProperties}
        data-testid="my-hats-grid"
      >
        {hats.map((hat) => (
          <MyHatCard
            key={`${hat.cosmeticId}:${hat.claimKey}`}
            hat={hat}
            color={teamColor}
            minutesLeft={minutesLeft(hat)}
            onPlace={() => openPicker(hat)}
          />
        ))}
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
            {boxPrice != null && (
              <Text size="xs" c="dimmed" data-testid="get-another-hat-box">
                or try the Mystery Box · {numberWithCommas(boxPrice)}
              </Text>
            )}
          </a>
        )}
      </SimpleGrid>
    </Stack>
  );
}
