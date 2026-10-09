import { Group, Text, UnstyledButton } from '@mantine/core';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import type { CosmeticShopItemGetById } from '~/types/router';

/**
 * A hat for sale on the event page. Opens the shop's own preview, so buying here is buying in the
 * shop: same checks, same purchase.
 */
export function EventHatTile({ item, color }: { item: CosmeticShopItemGetById; color?: string }) {
  const url = (item.cosmetic?.data as { url?: unknown } | null)?.url;
  const purchases = (item.meta as CosmeticShopItemMeta | null)?.purchases ?? 0;
  const soldOut = item.availableQuantity != null && item.availableQuantity - purchases <= 0;

  return (
    <UnstyledButton
      disabled={soldOut || !item.cosmetic}
      onClick={() =>
        dialogStore.trigger({
          component: CosmeticShopItemPreviewModal,
          props: { shopItem: item },
        })
      }
      className="flex flex-col gap-2 rounded-lg border border-solid border-gray-3 p-2 transition-colors hover:border-gray-5 disabled:opacity-50 dark:border-dark-4 dark:hover:border-dark-2"
    >
      {typeof url === 'string' && <HatArt url={url} color={color} />}
      <Group justify="space-between" gap="xs" wrap="nowrap" px={4}>
        <Text fw={700} size="sm" truncate>
          {item.title}
        </Text>
        <CurrencyBadge
          currency={Currency.BUZZ}
          unitAmount={item.unitAmount}
          variant="transparent"
          className="shrink-0 !px-0"
        />
      </Group>
      {soldOut && (
        <Text size="xs" c="dimmed" px={4}>
          Sold out
        </Text>
      )}
    </UnstyledButton>
  );
}
