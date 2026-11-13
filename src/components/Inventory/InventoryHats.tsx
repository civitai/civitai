import { Anchor, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useTeamColor } from '~/components/Events/events.utils';
import { MyHatCard } from '~/components/Events/ScoredEvent/MyHatCard';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { minutesUntilMovable } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { UserCosmetics } from '~/components/Inventory/inventory-cosmetics';
import { hatsOf, useInventoryCosmetics } from '~/components/Inventory/inventory-cosmetics';
import { CosmeticCard } from '~/components/Inventory/InventoryCosmetics';
import { NextLink } from '~/components/NextLink/NextLink';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import { trpc } from '~/utils/trpc';

const DEFAULT_HAT_COLOR = 'var(--mantine-color-blue-5)';

export function InventoryHats() {
  const { data, isLoading } = useInventoryCosmetics();
  const byEvent = groupByEvent(hatsOf(data));

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!byEvent.size)
    return (
      <Text c="dimmed" py="xl" ta="center">
        Hats you get at events land here.
      </Text>
    );

  return (
    <Stack gap="xl">
      {[...byEvent].map(([event, owned]) => (
        <EventHats key={event} event={event} owned={owned} />
      ))}
    </Stack>
  );
}

type OwnedHat = UserCosmetics['contentDecorations'][number];

function groupByEvent(hats: OwnedHat[]) {
  const byEvent = new Map<string, OwnedHat[]>();
  for (const hat of hats) {
    const { event } = hat.data as { event: string };
    byEvent.set(event, [...(byEvent.get(event) ?? []), hat]);
  }
  return byEvent;
}

function EventHats({ event, owned }: { event: string; owned: OwnedHat[] }) {
  const {
    data: hats,
    isLoading,
    isError,
    dataUpdatedAt,
  } = trpc.event.getMyHats.useQuery({ event });
  const teamColor = useTeamColor();
  const definition = getEventDecorationDefinition(event);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Stack gap="sm" data-testid="inventory-event-hats" data-event={event}>
      <Group justify="space-between" align="baseline">
        <Title order={3} size="h4">
          {definition?.eventTitle ?? event}
        </Title>
        {!isError && (
          <Anchor component={NextLink} href={`/events/${event}`} size="sm">
            {definition?.eventLinkLabel ?? 'See the event'}
          </Anchor>
        )}
      </Group>
      {isError ? (
        // The read is refused for an event the viewer can no longer see (any error lands here too):
        // list their hats from what they own, with no action.
        <SimpleGrid cols={{ base: 2, md: 3 }} spacing="md">
          {owned.map((hat) => (
            <CosmeticCard
              key={`${hat.id}:${hat.claimKey}`}
              item={hat}
              testId="inventory-unplaceable-hat"
              footer={null}
            />
          ))}
        </SimpleGrid>
      ) : isLoading || !hats ? (
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
