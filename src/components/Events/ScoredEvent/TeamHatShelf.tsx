import {
  Center,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconShoppingBag } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
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
  const { data: sections, isLoading } = trpc.cosmeticShop.getShop.useQuery({});
  const [price, setPrice] = useState('all');

  const items = useMemo(() => {
    const seen = new Map<number, CosmeticShopItemGetById>();
    for (const section of sections ?? [])
      for (const { shopItem } of section.items) {
        const data = shopItem.cosmetic?.data as { event?: unknown } | null | undefined;
        if (data?.event === event && !seen.has(shopItem.id))
          seen.set(shopItem.id, shopItem as CosmeticShopItemGetById);
      }
    return [...seen.values()].sort((a, b) => a.unitAmount - b.unitAmount || a.id - b.id);
  }, [sections, event]);
  const prices = [...new Set(items.map((i) => i.unitAmount))];
  const shown = price === 'all' ? items : items.filter((i) => i.unitAmount === Number(price));

  return (
    <Stack gap="md" id="team-hats">
      <Group justify="space-between" align="flex-end">
        <Stack gap={4}>
          <Group gap={8}>
            <IconShoppingBag size={24} />
            <Title order={2}>Team {team} hats</Title>
          </Group>
          <Text size="sm" c="dimmed">
            Every design in your colour. Each one is a separate hat you can place.
          </Text>
        </Stack>
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
