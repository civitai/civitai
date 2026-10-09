import {
  Badge,
  Center,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { IconClock, IconShoppingBag } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTeamColor } from '~/components/Events/events.utils';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { EventHatTile } from '~/components/Events/ScoredEvent/EventHatTile';
import type { CosmeticShopItemGetById } from '~/types/router';
import { daysFromNow } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * The event's items in the shop, for a member of a team. The shop already decides who sees which
 * item (team colour, event window, flag) and runs the purchase; this lists the event's share of it
 * with tiles that open the shop's own preview, so buying here is buying in the shop.
 */
export function TeamHatShelf({ event, team }: { event: string; team: string }) {
  const teamColor = useTeamColor();
  const { data: sections, isLoading } = trpc.cosmeticShop.getShop.useQuery({ event });
  const [price, setPrice] = useState('all');

  const items = useMemo(() => {
    const seen = new Map<number, CosmeticShopItemGetById>();
    for (const section of sections ?? [])
      for (const { shopItem } of section.items) {
        // The server already narrowed this to the event's items in the viewer's colour.
        if (!seen.has(shopItem.id)) seen.set(shopItem.id, shopItem as CosmeticShopItemGetById);
      }
    return [...seen.values()].sort((a, b) => a.unitAmount - b.unitAmount || a.id - b.id);
  }, [sections]);
  const prices = [...new Set(items.map((i) => i.unitAmount))];
  // Event items leave the shop together; say when once instead of on every tile.
  const leavesAt = items
    .map((i) => i.availableTo)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const shown = price === 'all' ? items : items.filter((i) => i.unitAmount === Number(price));

  return (
    <Stack gap="md" id="team-hats">
      <EventSectionHeading
        icon={IconShoppingBag}
        title={`Team ${team} hats`}
        color={teamColor(team)}
        subtitle="Every design in your colour. Each one is a separate hat you can place."
      >
        <Group gap="sm">
          {leavesAt && (
            <Badge
              variant="light"
              color="violet"
              leftSection={<IconClock size={12} />}
              data-testid="shelf-leaves"
            >
              Leaves {daysFromNow(leavesAt)}
            </Badge>
          )}
          {prices.length > 1 && (
            <SegmentedControl
              radius="xl"
              size="xs"
              value={price}
              onChange={setPrice}
              data={[
                { label: 'All', value: 'all' },
                ...prices.map((p) => ({ label: numberWithCommas(p), value: String(p) })),
              ]}
            />
          )}
        </Group>
      </EventSectionHeading>
      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : !shown.length ? (
        <Text c="dimmed">No hats are for sale right now.</Text>
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="md">
          {shown.map((item) => (
            <EventHatTile key={item.id} item={item} color={teamColor(team)} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
