import { Button, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArrowsMove, IconClock, IconEye, IconHeart, IconHanger } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { minutesUntilMovable } from '~/components/Events/ScoredEvent/scored-event.utils';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

type MyHat = RouterOutput['event']['getMyHats'][number];

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

      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        {hats.map((hat) => {
          const minutesLeft = minutesUntilMovable(
            hat.moveCooldownLeftMs,
            now.getTime() - fetchedAt
          );
          return (
            <SpotlightBorderCard
              key={`${hat.cosmeticId}:${hat.claimKey}`}
              color={teamColor}
              size={260}
            >
              <Stack gap="md" p="md" h="100%">
                <Group gap="md" wrap="nowrap">
                  <div className="w-12 shrink-0">
                    <EdgeMedia src={hat.data.url} width={96} alt="" />
                  </div>
                  <Stack gap={0} className="min-w-0 flex-1">
                    <Text fw={700} truncate>
                      {hat.name}
                    </Text>
                    <Text size="sm" c="dimmed" truncate>
                      {hat.placedOn
                        ? `On ${
                            hat.placedOn.title ?? `your ${hat.placedOn.entityType.toLowerCase()}`
                          }`
                        : 'Not on anything yet'}
                    </Text>
                  </Stack>
                  <Stack gap={0} align="flex-end">
                    <Text fw={800} fz={24} c={teamColor} className="tabular-nums" lh={1.1}>
                      {abbreviateNumber(hat.points)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      points
                    </Text>
                  </Stack>
                </Group>

                {hat.placedOn ? (
                  <Group gap="md" wrap="nowrap" align="stretch">
                    <div className="w-24 shrink-0">
                      <EventContentThumb
                        entityType={hat.placedOn.entityType}
                        image={hat.placedOn.image}
                        hat={hat.data}
                      />
                    </div>
                    <Stack gap={6} justify="center" className="flex-1">
                      <Group gap={6} wrap="nowrap">
                        <IconEye size={16} className="shrink-0 opacity-60" />
                        <Text size="sm" className="tabular-nums">
                          {numberWithCommas(hat.impressions)} views
                        </Text>
                      </Group>
                      <Group gap={6} wrap="nowrap">
                        <IconHeart size={16} className="shrink-0 opacity-60" />
                        <Text size="sm" className="tabular-nums">
                          {numberWithCommas(hat.reactions)} reactions
                        </Text>
                      </Group>
                    </Stack>
                  </Group>
                ) : (
                  <Text
                    size="sm"
                    c="dimmed"
                    className="rounded-md border border-dashed border-gray-4 p-3 dark:border-dark-3"
                  >
                    It scores only while it&apos;s on something. Put it on a post people already
                    look at.
                  </Text>
                )}

                {!ended && (
                  <Group gap="sm" mt="auto">
                    <Button
                      radius="xl"
                      variant={hat.placedOn ? 'default' : 'filled'}
                      leftSection={
                        hat.placedOn ? <IconArrowsMove size={16} /> : <IconHanger size={16} />
                      }
                      disabled={minutesLeft > 0}
                      onClick={() => openPicker(hat)}
                    >
                      {hat.placedOn ? 'Move' : 'Place it'}
                    </Button>
                    {minutesLeft > 0 && (
                      <Text size="xs" c="dimmed">
                        <IconClock size={12} className="inline align-[-1px]" /> Can move in{' '}
                        {minutesLeft} min
                      </Text>
                    )}
                  </Group>
                )}
              </Stack>
            </SpotlightBorderCard>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
