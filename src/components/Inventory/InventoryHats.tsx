import { Anchor, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useTeamColor } from '~/components/Events/events.utils';
import { MyHatCard } from '~/components/Events/ScoredEvent/MyHatCard';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { minutesUntilMovable } from '~/components/Events/ScoredEvent/scored-event.utils';
import { hatEventsOf, useInventoryCosmetics } from '~/components/Inventory/inventory-cosmetics';
import { NextLink } from '~/components/NextLink/NextLink';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import { trpc } from '~/utils/trpc';

const DEFAULT_HAT_COLOR = 'var(--mantine-color-blue-5)';

export function InventoryHats() {
  const { data, isLoading } = useInventoryCosmetics();
  const events = hatEventsOf(data);

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!events.length)
    return (
      <Text c="dimmed" py="xl" ta="center">
        Hats you get at events land here.
      </Text>
    );

  return (
    <Stack gap="xl">
      {events.map((event) => (
        <EventHats key={event} event={event} />
      ))}
    </Stack>
  );
}

/** One event's hats, from the same read and with the same Place it / Move as its event page. */
function EventHats({ event }: { event: string }) {
  const {
    data: hats,
    isLoading,
    isError,
    dataUpdatedAt,
  } = trpc.event.getMyHats.useQuery({ event });
  const teamColor = useTeamColor();
  const definition = getEventDecorationDefinition(event);
  // Re-reads the clock every half minute, so a hat's Move button unlocks when its cooldown ends.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // An event this viewer can no longer read refuses the read and every placement: leave it out.
  if (isError) return null;

  return (
    <Stack gap="sm" data-testid="inventory-event-hats" data-event={event}>
      <Group justify="space-between" align="baseline">
        <Title order={3} size="h4">
          {definition?.eventTitle ?? event}
        </Title>
        <Anchor component={NextLink} href={`/events/${event}`} size="sm">
          {definition?.eventLinkLabel ?? 'See the event'}
        </Anchor>
      </Group>
      {isLoading || !hats ? (
        <Center p="md">
          <Loader size="sm" />
        </Center>
      ) : (
        <SimpleGrid
          cols={{ base: 2, md: 3 }}
          spacing="md"
          className="pt-4 [--event-decoration-allowance:16px]"
        >
          {hats.map((hat) => (
            <MyHatCard
              key={`${hat.cosmeticId}:${hat.claimKey}`}
              hat={hat}
              color={(hat.data.team && teamColor(hat.data.team)) || DEFAULT_HAT_COLOR}
              minutesLeft={minutesUntilMovable(
                hat.moveCooldownLeftMs,
                now.getTime() - dataUpdatedAt
              )}
              // The server places a hat only for an event it has a definition for.
              onPlace={
                definition
                  ? () =>
                      dialogStore.trigger({
                        component: PlaceHatModal,
                        props: { event, hat, myHats: hats },
                      })
                  : undefined
              }
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
