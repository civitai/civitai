import { Center, Loader, SegmentedControl, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconShoppingBag } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useTeamColor } from '~/components/Events/events.utils';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { ShopItem } from '~/components/Shop/ShopItem';
import type { CosmeticShopItemGetById } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * The event's items in the shop, for a member of a team. The shop already decides who sees which
 * item (team colour, event window, flag) and runs the purchase; this lists the event's share of it
 * with the shop's own card, so buying here is buying in the shop.
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
  const shown = price === 'all' ? items : items.filter((i) => i.unitAmount === Number(price));

  return (
    <Stack gap="md" id="team-hats">
      <EventSectionHeading
        icon={IconShoppingBag}
        title={`Team ${team} hats`}
        color={teamColor(team)}
        subtitle="Every design in your colour. Each one is a separate hat you can place."
      >
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
            <ShopItem key={item.id} item={item} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
