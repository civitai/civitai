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
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
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
  const [buzzType] = useAvailableBuzz();

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
  // One group per price, cheapest first; `shown` is already in price order.
  const tiers: { price: number; items: CosmeticShopItemGetById[] }[] = [];
  for (const item of shown) {
    const last = tiers[tiers.length - 1];
    if (last?.price === item.unitAmount) last.items.push(item);
    else tiers.push({ price: item.unitAmount, items: [item] });
  }

  return (
    <Stack gap="md" id="team-hats">
      <EventSectionHeading
        icon={IconShoppingBag}
        title={`Team ${team} hats`}
        color={teamColor(team)}
        subtitle="Every design in your colour. Pick one to preview and buy it."
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
        <Stack gap="lg">
          {tiers.map((tier) => (
            <Stack key={tier.price} gap="sm" data-testid="shelf-tier">
              {prices.length > 1 && (
                <Group gap="sm" wrap="nowrap">
                  <Group gap={4} wrap="nowrap" className="shrink-0">
                    <CurrencyIcon currency="BUZZ" type={buzzType} size={16} />
                    <Text fw={800} className="tabular-nums">
                      {numberWithCommas(tier.price)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      · {tier.items.length} {tier.items.length === 1 ? 'hat' : 'hats'}
                    </Text>
                  </Group>
                  <div className="h-px flex-1 bg-gray-3 dark:bg-dark-4" />
                </Group>
              )}
              <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6 }} spacing="sm">
                {tier.items.map((item) => (
                  <EventHatTile
                    key={item.id}
                    item={item}
                    color={teamColor(team)}
                    tier={prices.indexOf(tier.price)}
                  />
                ))}
              </SimpleGrid>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
